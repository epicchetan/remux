#![doc = include_str!("../README.md")]

use std::collections::{BTreeMap, VecDeque};
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const COMPUTE_TASK_ENV: &str = "REMUX_COMPUTE_TASK";
const COMPUTE_PROTOCOL_ENV: &str = "REMUX_COMPUTE_PROTOCOL";
const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDERR_BYTES: u64 = 1024 * 1024;

/// A finite unit of process-isolated compute.
pub trait Task: Send + Sync + 'static {
    const NAME: &'static str;
    const VERSION: u32;

    type Input: Serialize + DeserializeOwned + Send + 'static;
    type Progress: Serialize + DeserializeOwned + Send + 'static;
    type Output: Serialize + DeserializeOwned + Send + 'static;

    fn run(
        context: TaskContext<Self::Progress>,
        input: Self::Input,
    ) -> Result<Self::Output, String>;
}

/// Worker context supplied to a task implementation.
pub struct TaskContext<P> {
    sink: ProgressSink,
    threads: usize,
    marker: PhantomData<fn(P)>,
}

impl<P> Clone for TaskContext<P> {
    fn clone(&self) -> Self {
        Self {
            sink: self.sink.clone(),
            threads: self.threads,
            marker: PhantomData,
        }
    }
}

impl<P: Serialize> TaskContext<P> {
    /// The manifest-owned maximum concurrency granted to this worker.
    pub fn threads(&self) -> usize {
        self.threads
    }

    /// Emit one typed progress value to the parent extension.
    pub fn progress(&self, progress: P) -> Result<(), String> {
        self.sink.emit(Frame::Progress {
            payload: serde_json::to_value(progress)
                .map_err(|error| format!("failed to encode task progress: {error}"))?,
        })
    }
}

#[derive(Clone)]
struct ProgressSink {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl ProgressSink {
    fn emit(&self, frame: Frame) -> Result<(), String> {
        let encoded = serde_json::to_vec(&frame)
            .map_err(|error| format!("failed to encode compute frame: {error}"))?;
        if encoded.len() > MAX_FRAME_BYTES {
            return Err(format!(
                "compute frame is too large: {}>{MAX_FRAME_BYTES}",
                encoded.len()
            ));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "compute output writer poisoned".to_string())?;
        writer
            .write_all(&encoded)
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write compute frame: {error}"))
    }
}

/// Manifest resource profile and semantic operation identity for one task.
#[derive(Clone, Debug)]
pub struct TaskOptions {
    workload: String,
    operation: String,
}

impl TaskOptions {
    pub fn new(workload: impl Into<String>, operation: impl Into<String>) -> Self {
        Self {
            workload: workload.into(),
            operation: operation.into(),
        }
    }
}

/// Compiled task registry shared by the extension server and its worker mode.
#[derive(Clone, Debug, Default)]
pub struct Registry {
    tasks: Arc<BTreeMap<&'static str, RegisteredTask>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<T: Task>(self) -> Result<Self, ComputeError> {
        if T::NAME.trim().is_empty() {
            return Err(ComputeError::Registration(
                "compute task name cannot be empty".to_string(),
            ));
        }
        let mut tasks = (*self.tasks).clone();
        if tasks
            .insert(
                T::NAME,
                RegisteredTask {
                    version: T::VERSION,
                    run: run_registered::<T>,
                },
            )
            .is_some()
        {
            return Err(ComputeError::Registration(format!(
                "duplicate compute task {}",
                T::NAME
            )));
        }
        Ok(Self {
            tasks: Arc::new(tasks),
        })
    }

    /// Run the registered task when this executable was re-entered as a worker.
    /// Returns `false` during normal extension-server startup.
    pub fn dispatch_worker_if_requested(&self) -> Result<bool, ComputeError> {
        let Some(task_name) = env::var_os(COMPUTE_TASK_ENV) else {
            return Ok(false);
        };
        let task_name = task_name
            .into_string()
            .map_err(|_| ComputeError::Protocol("compute task name is not UTF-8".to_string()))?;
        let protocol = env::var(COMPUTE_PROTOCOL_ENV)
            .ok()
            .and_then(|value| value.parse::<u32>().ok());
        if protocol != Some(PROTOCOL_VERSION) {
            return Err(ComputeError::Protocol(
                "unsupported compute worker protocol".to_string(),
            ));
        }
        let task = self.tasks.get(task_name.as_str()).ok_or_else(|| {
            ComputeError::Registration(format!("compute task {task_name} is not registered"))
        })?;
        dispatch_registered(&task_name, task)?;
        Ok(true)
    }

    /// Start one registered task in the current extension executable.
    pub fn spawn<T: Task>(
        &self,
        options: TaskOptions,
        input: T::Input,
    ) -> Result<TaskHandle<T>, ComputeError> {
        let registered = self.tasks.get(T::NAME).ok_or_else(|| {
            ComputeError::Registration(format!("compute task {} is not registered", T::NAME))
        })?;
        if registered.version != T::VERSION {
            return Err(ComputeError::Registration(format!(
                "compute task {} version mismatch",
                T::NAME
            )));
        }
        let request = Request {
            input: serde_json::to_value(input)
                .map_err(|error| ComputeError::Protocol(error.to_string()))?,
            protocol_version: PROTOCOL_VERSION,
            task: T::NAME.to_string(),
            task_version: T::VERSION,
        };
        let encoded = serde_json::to_vec(&request)
            .map_err(|error| ComputeError::Protocol(error.to_string()))?;
        if encoded.len() > MAX_REQUEST_BYTES {
            return Err(ComputeError::Protocol(format!(
                "compute request is too large: {}>{MAX_REQUEST_BYTES}",
                encoded.len()
            )));
        }

        let executable = current_executable()?;
        let mut command = workload_command(&options, &executable);
        command
            .env(COMPUTE_TASK_ENV, T::NAME)
            .env(COMPUTE_PROTOCOL_ENV, PROTOCOL_VERSION.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(ComputeError::Spawn)?;
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ComputeError::Protocol(
                "compute worker stdin is unavailable".to_string(),
            ));
        };
        if let Err(error) = stdin
            .write_all(&encoded)
            .and_then(|_| stdin.write_all(b"\n"))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ComputeError::Protocol(format!(
                "failed to write compute request: {error}"
            )));
        }
        drop(stdin);

        TaskHandle::new(child)
    }
}

#[derive(Clone, Debug)]
struct RegisteredTask {
    version: u32,
    run: fn(Value, ProgressSink, usize) -> Result<Value, String>,
}

fn run_registered<T: Task>(
    input: Value,
    sink: ProgressSink,
    threads: usize,
) -> Result<Value, String> {
    let input = serde_json::from_value::<T::Input>(input)
        .map_err(|error| format!("invalid input for {}: {error}", T::NAME))?;
    let output = T::run(
        TaskContext {
            sink,
            threads,
            marker: PhantomData,
        },
        input,
    )?;
    serde_json::to_value(output).map_err(|error| format!("failed to encode task output: {error}"))
}

fn dispatch_registered(task_name: &str, task: &RegisteredTask) -> Result<(), ComputeError> {
    let request = read_request(std::io::stdin().lock())?;
    if request.protocol_version != PROTOCOL_VERSION
        || request.task != task_name
        || request.task_version != task.version
    {
        return Err(ComputeError::Protocol(
            "compute request does not match the registered worker".to_string(),
        ));
    }
    let writer: Box<dyn Write + Send> = Box::new(BufWriter::new(std::io::stdout()));
    let sink = ProgressSink {
        writer: Arc::new(Mutex::new(writer)),
    };
    let threads = env::var("REMUX_WORKLOAD_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    match (task.run)(request.input, sink.clone(), threads) {
        Ok(payload) => sink.emit(Frame::Complete { payload }),
        Err(message) => {
            let _ = sink.emit(Frame::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
    .map_err(ComputeError::Task)
}

fn read_request(reader: impl Read) -> Result<Request, ComputeError> {
    let mut reader = BufReader::new(reader);
    let mut encoded = Vec::new();
    reader
        .by_ref()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_until(b'\n', &mut encoded)
        .map_err(|error| ComputeError::Protocol(error.to_string()))?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err(ComputeError::Protocol(format!(
            "compute request exceeds {MAX_REQUEST_BYTES} bytes"
        )));
    }
    serde_json::from_slice(&encoded).map_err(|error| ComputeError::Protocol(error.to_string()))
}

#[derive(Debug)]
enum WorkerEvent<T: Task> {
    Progress(T::Progress),
    Complete(T::Output),
}

/// Parent-side handle for one finite compute task.
pub struct TaskHandle<T: Task> {
    child: Child,
    events: mpsc::Receiver<Result<WorkerEvent<T>, ComputeError>>,
    stderr: mpsc::Receiver<String>,
    progress: VecDeque<T::Progress>,
    output: Option<T::Output>,
}

impl<T: Task> TaskHandle<T> {
    fn new(mut child: Child) -> Result<Self, ComputeError> {
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ComputeError::Protocol(
                "compute worker stdout is unavailable".to_string(),
            ));
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ComputeError::Protocol(
                "compute worker stderr is unavailable".to_string(),
            ));
        };
        let (event_tx, event_rx) = mpsc::sync_channel(64);
        thread::spawn(move || read_task_frames::<T>(stdout, event_tx));
        let (stderr_tx, stderr_rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut stderr = BufReader::new(stderr);
            let mut buffer = [0_u8; 8 * 1024];
            let mut truncated = false;
            loop {
                let Ok(count) = stderr.read(&mut buffer) else {
                    break;
                };
                if count == 0 {
                    break;
                }
                let remaining = (MAX_STDERR_BYTES as usize).saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..count.min(remaining)]);
                truncated |= count > remaining;
            }
            let mut text = String::from_utf8_lossy(&bytes).into_owned();
            if truncated {
                text.push_str("\n[stderr truncated]");
            }
            let _ = stderr_tx.send(text);
        });
        Ok(Self {
            child,
            events: event_rx,
            stderr: stderr_rx,
            progress: VecDeque::new(),
            output: None,
        })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Receive one available progress value without blocking.
    pub fn try_progress(&mut self) -> Result<Option<T::Progress>, ComputeError> {
        if let Some(progress) = self.progress.pop_front() {
            return Ok(Some(progress));
        }
        loop {
            match self.events.try_recv() {
                Ok(Ok(WorkerEvent::Progress(progress))) => return Ok(Some(progress)),
                Ok(Ok(WorkerEvent::Complete(output))) => self.output = Some(output),
                Ok(Err(error)) => return Err(error),
                Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => {
                    return Ok(None);
                }
            }
        }
    }

    /// Wait for the next progress value. Returns `None` after task completion.
    pub fn recv_progress(&mut self) -> Result<Option<T::Progress>, ComputeError> {
        if let Some(progress) = self.progress.pop_front() {
            return Ok(Some(progress));
        }
        if self.output.is_some() {
            return Ok(None);
        }
        loop {
            match self.events.recv() {
                Ok(Ok(WorkerEvent::Progress(progress))) => return Ok(Some(progress)),
                Ok(Ok(WorkerEvent::Complete(output))) => {
                    self.output = Some(output);
                    return Ok(None);
                }
                Ok(Err(error)) => {
                    let _ = self.child.wait();
                    return Err(error);
                }
                Err(_) => {
                    let status = self.child.wait().map_err(ComputeError::Spawn)?;
                    return Err(self.exit_error(status));
                }
            }
        }
    }

    /// Return the typed output once the worker has exited successfully.
    pub fn try_join(&mut self) -> Result<Option<T::Output>, ComputeError> {
        self.drain_available()?;
        let Some(status) = self.child.try_wait().map_err(ComputeError::Spawn)? else {
            return Ok(None);
        };
        self.finish_after_exit(status).map(Some)
    }

    pub fn wait(mut self) -> Result<T::Output, ComputeError> {
        while self.output.is_none() {
            match self.events.recv() {
                Ok(Ok(WorkerEvent::Progress(progress))) => self.progress.push_back(progress),
                Ok(Ok(WorkerEvent::Complete(output))) => self.output = Some(output),
                Ok(Err(error)) => {
                    let _ = self.child.wait();
                    return Err(error);
                }
                Err(_) => break,
            }
        }
        let status = self.child.wait().map_err(ComputeError::Spawn)?;
        self.finish_after_exit(status)
    }

    pub fn cancel(&mut self) -> Result<(), ComputeError> {
        if self
            .child
            .try_wait()
            .map_err(ComputeError::Spawn)?
            .is_none()
        {
            self.child.kill().map_err(ComputeError::Spawn)?;
        }
        let _ = self.child.wait();
        Ok(())
    }

    fn drain_available(&mut self) -> Result<(), ComputeError> {
        loop {
            match self.events.try_recv() {
                Ok(Ok(WorkerEvent::Progress(progress))) => self.progress.push_back(progress),
                Ok(Ok(WorkerEvent::Complete(output))) => self.output = Some(output),
                Ok(Err(error)) => return Err(error),
                Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => return Ok(()),
            }
        }
    }

    fn finish_after_exit(&mut self, status: ExitStatus) -> Result<T::Output, ComputeError> {
        while self.output.is_none() {
            match self.events.recv() {
                Ok(Ok(WorkerEvent::Progress(progress))) => self.progress.push_back(progress),
                Ok(Ok(WorkerEvent::Complete(output))) => self.output = Some(output),
                Ok(Err(error)) => return Err(error),
                Err(_) => break,
            }
        }
        if !status.success() {
            return Err(self.exit_error(status));
        }
        self.output.take().ok_or_else(|| {
            ComputeError::Protocol("compute worker exited without a completion frame".to_string())
        })
    }

    fn exit_error(&self, status: ExitStatus) -> ComputeError {
        let stderr = self
            .stderr
            .recv_timeout(Duration::from_millis(100))
            .unwrap_or_default();
        ComputeError::WorkerExited {
            status,
            stderr: stderr.trim().to_string(),
        }
    }
}

impl<T: Task> Drop for TaskHandle<T> {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn read_task_frames<T: Task>(
    reader: impl Read,
    sender: mpsc::SyncSender<Result<WorkerEvent<T>, ComputeError>>,
) {
    let mut reader = BufReader::new(reader);
    loop {
        let mut encoded = Vec::new();
        match reader
            .by_ref()
            .take((MAX_FRAME_BYTES + 1) as u64)
            .read_until(b'\n', &mut encoded)
        {
            Ok(0) => break,
            Ok(_) if encoded.len() > MAX_FRAME_BYTES => {
                let _ = sender.send(Err(ComputeError::Protocol(format!(
                    "compute frame exceeds {MAX_FRAME_BYTES} bytes"
                ))));
                break;
            }
            Ok(_) => {}
            Err(error) => {
                let _ = sender.send(Err(ComputeError::Protocol(error.to_string())));
                break;
            }
        }
        let event = serde_json::from_slice::<Frame>(&encoded)
            .map_err(|error| ComputeError::Protocol(error.to_string()))
            .and_then(|frame| match frame {
                Frame::Progress { payload } => serde_json::from_value(payload)
                    .map(WorkerEvent::Progress)
                    .map_err(|error| ComputeError::Protocol(error.to_string())),
                Frame::Complete { payload } => serde_json::from_value(payload)
                    .map(WorkerEvent::Complete)
                    .map_err(|error| ComputeError::Protocol(error.to_string())),
                Frame::Error { message } => Err(ComputeError::Task(message)),
            });
        let terminal = matches!(event, Ok(WorkerEvent::Complete(_)) | Err(_));
        if sender.send(event).is_err() || terminal {
            break;
        }
    }
}

#[derive(Debug)]
pub enum ComputeError {
    Registration(String),
    Protocol(String),
    Task(String),
    Spawn(std::io::Error),
    WorkerExited { status: ExitStatus, stderr: String },
}

impl std::fmt::Display for ComputeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Registration(message) | Self::Protocol(message) | Self::Task(message) => {
                formatter.write_str(message)
            }
            Self::Spawn(error) => write!(formatter, "failed to start compute worker: {error}"),
            Self::WorkerExited { status, stderr } if stderr.is_empty() => {
                write!(formatter, "compute worker exited with {status}")
            }
            Self::WorkerExited { status, stderr } => {
                write!(formatter, "compute worker exited with {status}: {stderr}")
            }
        }
    }
}

impl std::error::Error for ComputeError {}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    protocol_version: u32,
    task: String,
    task_version: u32,
    input: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Frame {
    Progress { payload: Value },
    Complete { payload: Value },
    Error { message: String },
}

fn workload_command(options: &TaskOptions, executable: &Path) -> Command {
    let mut command = Command::new(wrapper());
    command
        .args(["workload", "exec", "--workload", &options.workload])
        .args(["--operation", &options.operation])
        .arg("--")
        .arg(executable);
    command
}

fn wrapper() -> OsString {
    env::var_os("REMUX_WORKLOAD_EXEC").unwrap_or_else(|| OsString::from("remux"))
}

fn current_executable() -> Result<PathBuf, ComputeError> {
    let argv0 = env::args_os().next().map(PathBuf::from);
    if let Some(path) = argv0.as_ref().filter(|path| executable_path(path)) {
        return Ok(path.clone());
    }
    env::current_exe()
        .map_err(ComputeError::Spawn)
        .and_then(|path| {
            if executable_path(&path) {
                Ok(path)
            } else {
                Err(ComputeError::Registration(format!(
                    "current extension executable is unavailable: {}",
                    path.display()
                )))
            }
        })
}

fn executable_path(path: &Path) -> bool {
    path.components().count() > 1 && path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, Serialize, PartialEq)]
    struct Input {
        value: u64,
    }

    #[derive(Debug, Deserialize, Serialize, PartialEq)]
    struct Progress {
        seen: u64,
        threads: usize,
    }

    #[derive(Debug, Deserialize, Serialize, PartialEq)]
    struct Output {
        value: u64,
    }

    struct Double;

    impl Task for Double {
        const NAME: &'static str = "fixture.double";
        const VERSION: u32 = 3;
        type Input = Input;
        type Progress = Progress;
        type Output = Output;

        fn run(
            context: TaskContext<Self::Progress>,
            input: Self::Input,
        ) -> Result<Self::Output, String> {
            context.progress(Progress {
                seen: input.value,
                threads: context.threads(),
            })?;
            Ok(Output {
                value: input.value * 2,
            })
        }
    }

    #[test]
    fn registry_rejects_duplicate_task_names() {
        let registry = Registry::new().register::<Double>().unwrap();
        assert!(matches!(
            registry.register::<Double>(),
            Err(ComputeError::Registration(message)) if message.contains("duplicate")
        ));
    }

    #[test]
    fn registered_task_emits_typed_progress_and_output() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let writer = SharedWriter(output.clone());
        let sink = ProgressSink {
            writer: Arc::new(Mutex::new(Box::new(writer))),
        };
        let value = run_registered::<Double>(serde_json::json!({ "value": 21 }), sink, 4).unwrap();
        assert_eq!(value, serde_json::json!({ "value": 42 }));
        let bytes = output.lock().unwrap().clone();
        let frame: Frame = serde_json::from_slice(&bytes).unwrap();
        match frame {
            Frame::Progress { payload } => {
                assert_eq!(
                    serde_json::from_value::<Progress>(payload).unwrap(),
                    Progress {
                        seen: 21,
                        threads: 4,
                    }
                );
            }
            _ => panic!("expected progress frame"),
        }
    }

    #[test]
    fn request_validation_precedes_task_execution() {
        let request = serde_json::to_vec(&Request {
            protocol_version: PROTOCOL_VERSION,
            task: Double::NAME.to_string(),
            task_version: Double::VERSION,
            input: serde_json::json!({ "wrong": true }),
        })
        .unwrap();
        let decoded = read_request(request.as_slice()).unwrap();
        let output = Arc::new(Mutex::new(Vec::new()));
        let error = run_registered::<Double>(
            decoded.input,
            ProgressSink {
                writer: Arc::new(Mutex::new(Box::new(SharedWriter(output)))),
            },
            1,
        )
        .unwrap_err();
        assert!(error.contains("invalid input"), "{error}");
    }

    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
