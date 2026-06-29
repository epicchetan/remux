use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const FIELD_SEPARATOR: char = '|';
const TMUX_SCROLL_DEFAULT_LINES: u16 = 3;
const TMUX_SCROLL_MAX_LINES: u16 = 20;
const TMUX_TIMEOUT: Duration = Duration::from_millis(900);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTmuxContextParams {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTmuxActionParams {
    pub session_id: String,
    pub socket_path: Option<String>,
    pub action: TmuxAction,
    pub lines: Option<u16>,
    pub target: Option<TmuxActionTarget>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum TmuxAction {
    CloseWindow,
    ExitTmux,
    Refresh,
    SelectWindow,
    ScrollDown,
    ScrollUp,
    NewWindow,
    SwitchSession,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxActionTarget {
    pub tmux_session_id: Option<String>,
    pub tmux_window_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxActionResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<TmuxContext>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxContext {
    pub mode: TmuxMode,
    pub terminal_session_id: String,
    pub terminal_tty: Option<String>,
    pub current_client: Option<TmuxClient>,
    pub sockets: Vec<TmuxSocketState>,
    pub generated_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TmuxMode {
    None,
    Available,
    Attached,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSocketState {
    pub socket_path: Option<String>,
    pub available: bool,
    pub error: Option<String>,
    pub options: TmuxOptions,
    pub sessions: Vec<TmuxSession>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxOptions {
    pub prefix: Option<String>,
    pub prefix2: Option<String>,
    pub mouse: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxClient {
    pub tty: String,
    pub pid: Option<u32>,
    pub session_id: Option<String>,
    pub session_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub control_mode: bool,
    pub socket_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub id: String,
    pub name: String,
    pub attached: u32,
    pub window_count: u32,
    pub active_window_id: Option<String>,
    pub windows: Vec<TmuxWindow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindow {
    pub id: String,
    pub session_id: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub last: bool,
    pub pane_count: u32,
    pub layout: String,
    pub panes: Vec<TmuxPane>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPane {
    pub id: String,
    pub window_id: String,
    pub index: u32,
    pub active: bool,
    pub in_mode: bool,
    pub current_command: String,
    pub current_path: String,
    pub tty: String,
    pub pid: Option<u32>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug)]
struct ScannedSocket {
    clients: Vec<TmuxClient>,
    state: TmuxSocketState,
}

pub fn scan_context(
    terminal_session_id: &str,
    terminal_tty: Option<String>,
) -> Result<TmuxContext, String> {
    let mut sockets = Vec::new();
    let mut current_client = None;

    for socket_path in discover_tmux_sockets() {
        let scanned = match scan_socket(socket_path.as_deref()) {
            Ok(scanned) => scanned,
            Err(error) => ScannedSocket {
                clients: Vec::new(),
                state: TmuxSocketState {
                    socket_path: socket_path.clone(),
                    available: false,
                    error: Some(error),
                    options: TmuxOptions::default(),
                    sessions: Vec::new(),
                },
            },
        };

        if current_client.is_none() {
            if let Some(terminal_tty) = terminal_tty.as_deref() {
                current_client = scanned
                    .clients
                    .iter()
                    .find(|client| client.tty == terminal_tty)
                    .cloned();
            }
        }

        sockets.push(scanned.state);
    }

    let mode = if current_client.is_some() {
        TmuxMode::Attached
    } else if sockets
        .iter()
        .any(|socket| socket.available && !socket.sessions.is_empty())
    {
        TmuxMode::Available
    } else {
        TmuxMode::None
    };

    Ok(TmuxContext {
        mode,
        terminal_session_id: terminal_session_id.to_string(),
        terminal_tty,
        current_client,
        sockets,
        generated_at: unix_millis(),
    })
}

pub fn run_tmux_action(
    params: TerminalTmuxActionParams,
    terminal_tty: Option<String>,
) -> Result<TmuxActionResponse, String> {
    if params.action == TmuxAction::Refresh {
        return Ok(TmuxActionResponse {
            ok: true,
            context: Some(scan_context(&params.session_id, terminal_tty)?),
        });
    }

    let context = scan_context(&params.session_id, terminal_tty.clone())?;
    let socket_path = action_socket_path(&params, &context)?;
    let args = action_args(&params, &context)?;
    if !args.is_empty() {
        run_tmux_command(socket_path.as_deref(), &args)?;
    }

    Ok(TmuxActionResponse {
        ok: true,
        context: Some(scan_context(&params.session_id, terminal_tty)?),
    })
}

fn discover_tmux_sockets() -> Vec<Option<String>> {
    let mut sockets = Vec::new();
    let mut seen = HashSet::new();

    push_socket(&mut sockets, &mut seen, None);

    if let Ok(value) = env::var("TMUX") {
        if let Some(socket_path) = value.split(',').next().map(str::trim) {
            if !socket_path.is_empty() {
                push_socket(&mut sockets, &mut seen, Some(socket_path.to_string()));
            }
        }
    }

    for socket_path in same_user_socket_paths() {
        if socket_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name == "default")
        {
            continue;
        }

        push_socket(
            &mut sockets,
            &mut seen,
            Some(socket_path.to_string_lossy().to_string()),
        );
    }

    sockets
}

fn push_socket(
    sockets: &mut Vec<Option<String>>,
    seen: &mut HashSet<String>,
    socket_path: Option<String>,
) {
    let key = socket_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("<default>")
        .to_string();
    if seen.insert(key) {
        sockets.push(socket_path);
    }
}

fn same_user_socket_paths() -> Vec<PathBuf> {
    let Some(uid) = current_uid() else {
        return Vec::new();
    };

    let root = PathBuf::from(format!("/tmp/tmux-{uid}"));
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_unix_socket(path))
        .collect()
}

fn current_uid() -> Option<String> {
    env::var("UID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let output = Command::new("id").arg("-u").output().ok()?;
            if !output.status.success() {
                return None;
            }

            String::from_utf8(output.stdout)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

#[cfg(unix)]
fn is_unix_socket(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;

    fs::metadata(path)
        .map(|metadata| metadata.file_type().is_socket())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_unix_socket(_path: &Path) -> bool {
    false
}

fn scan_socket(socket_path: Option<&str>) -> Result<ScannedSocket, String> {
    let sessions_output = tmux_output(
        socket_path,
        &[
            "list-sessions".to_string(),
            "-F".to_string(),
            "#{session_id}|#{session_name}|#{session_attached}|#{session_windows}".to_string(),
        ],
    )?;
    let windows_output = tmux_output(
        socket_path,
        &[
            "list-windows".to_string(),
            "-a".to_string(),
            "-F".to_string(),
            "#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_last_flag}|#{window_panes}|#{window_layout}".to_string(),
        ],
    )?;
    let panes_output = tmux_output(
        socket_path,
        &[
            "list-panes".to_string(),
            "-a".to_string(),
            "-F".to_string(),
            "#{session_id}|#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_in_mode}|#{pane_current_command}|#{pane_current_path}|#{pane_tty}|#{pane_pid}|#{pane_width}|#{pane_height}".to_string(),
        ],
    )?;
    let clients_output = tmux_output(
        socket_path,
        &[
            "list-clients".to_string(),
            "-F".to_string(),
            "#{client_tty}|#{client_pid}|#{session_id}|#{session_name}|#{client_width}|#{client_height}|#{client_control_mode}".to_string(),
        ],
    )
    .unwrap_or_default();

    let mut sessions = parse_sessions(&sessions_output)?;
    let windows = parse_windows(&windows_output)?;
    let panes = parse_panes(&panes_output)?;

    attach_windows(&mut sessions, windows);
    attach_panes(&mut sessions, panes);

    let socket_path_owned = socket_path.map(ToOwned::to_owned);
    let clients = parse_clients(&clients_output, socket_path_owned.clone())?;
    let options = read_options(socket_path);

    Ok(ScannedSocket {
        clients,
        state: TmuxSocketState {
            socket_path: socket_path_owned,
            available: true,
            error: None,
            options,
            sessions,
        },
    })
}

fn read_options(socket_path: Option<&str>) -> TmuxOptions {
    let prefix = tmux_output(
        socket_path,
        &[
            "show-options".to_string(),
            "-gqv".to_string(),
            "prefix".to_string(),
        ],
    )
    .ok()
    .and_then(|value| tmux_option_string(&value));
    let prefix2 = tmux_output(
        socket_path,
        &[
            "show-options".to_string(),
            "-gqv".to_string(),
            "prefix2".to_string(),
        ],
    )
    .ok()
    .and_then(|value| tmux_option_string(&value));
    let mouse = tmux_output(
        socket_path,
        &[
            "show-options".to_string(),
            "-gqv".to_string(),
            "mouse".to_string(),
        ],
    )
    .ok()
    .and_then(|value| match value.trim() {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    });

    TmuxOptions {
        prefix,
        prefix2,
        mouse,
    }
}

fn tmux_option_string(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value == "None" {
        None
    } else {
        Some(value.to_string())
    }
}

fn tmux_output(socket_path: Option<&str>, args: &[String]) -> Result<String, String> {
    let output = run_tmux_command(socket_path, args)?;
    String::from_utf8(output.stdout).map_err(|error| format!("tmux output was not utf-8: {error}"))
}

fn run_tmux_command(
    socket_path: Option<&str>,
    args: &[String],
) -> Result<TmuxCommandOutput, String> {
    if let Some(socket_path) = socket_path {
        validate_socket_path(socket_path)?;
    }

    let mut command = Command::new("tmux");
    if let Some(socket_path) = socket_path {
        command.arg("-S").arg(socket_path);
    }
    command.args(args);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run tmux: {error}"))?;
    let deadline = Instant::now() + TMUX_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| format!("failed to collect tmux output: {error}"))?;
                if output.status.success() {
                    return Ok(TmuxCommandOutput {
                        stdout: output.stdout,
                    });
                }

                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    format!("tmux exited with status {}", output.status)
                } else {
                    stderr
                });
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("tmux command timed out".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => return Err(format!("failed to wait for tmux: {error}")),
        }
    }
}

struct TmuxCommandOutput {
    stdout: Vec<u8>,
}

fn parse_sessions(output: &str) -> Result<Vec<TmuxSession>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_session_line)
        .collect()
}

fn parse_session_line(line: &str) -> Result<TmuxSession, String> {
    let fields = split_fields(line, 4)?;
    Ok(TmuxSession {
        id: validate_tmux_id(fields[0], '$')?.to_string(),
        name: fields[1].to_string(),
        attached: parse_u32(fields[2], "session attached")?,
        window_count: parse_u32(fields[3], "session window count")?,
        active_window_id: None,
        windows: Vec::new(),
    })
}

fn parse_windows(output: &str) -> Result<Vec<TmuxWindow>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_window_line)
        .collect()
}

fn parse_window_line(line: &str) -> Result<TmuxWindow, String> {
    let fields = split_fields(line, 8)?;
    Ok(TmuxWindow {
        session_id: validate_tmux_id(fields[0], '$')?.to_string(),
        id: validate_tmux_id(fields[1], '@')?.to_string(),
        index: parse_u32(fields[2], "window index")?,
        name: fields[3].to_string(),
        active: parse_bool_flag(fields[4], "window active")?,
        last: parse_bool_flag(fields[5], "window last")?,
        pane_count: parse_u32(fields[6], "window pane count")?,
        layout: fields[7].to_string(),
        panes: Vec::new(),
    })
}

fn parse_panes(output: &str) -> Result<Vec<(String, TmuxPane)>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_pane_line)
        .collect()
}

fn parse_pane_line(line: &str) -> Result<(String, TmuxPane), String> {
    let fields = split_fields(line, 12)?;
    let session_id = validate_tmux_id(fields[0], '$')?.to_string();
    let window_id = validate_tmux_id(fields[1], '@')?.to_string();
    Ok((
        session_id,
        TmuxPane {
            window_id,
            id: validate_tmux_id(fields[2], '%')?.to_string(),
            index: parse_u32(fields[3], "pane index")?,
            active: parse_bool_flag(fields[4], "pane active")?,
            in_mode: parse_bool_flag(fields[5], "pane mode")?,
            current_command: fields[6].to_string(),
            current_path: fields[7].to_string(),
            tty: fields[8].to_string(),
            pid: parse_optional_u32(fields[9]),
            width: parse_u32(fields[10], "pane width")?,
            height: parse_u32(fields[11], "pane height")?,
        },
    ))
}

fn parse_clients(output: &str, socket_path: Option<String>) -> Result<Vec<TmuxClient>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| parse_client_line(line, socket_path.clone()))
        .collect()
}

fn parse_client_line(line: &str, socket_path: Option<String>) -> Result<TmuxClient, String> {
    let fields = split_fields(line, 7)?;
    Ok(TmuxClient {
        tty: fields[0].to_string(),
        pid: parse_optional_u32(fields[1]),
        session_id: if fields[2].is_empty() {
            None
        } else {
            Some(validate_tmux_id(fields[2], '$')?.to_string())
        },
        session_name: fields[3].to_string(),
        width: parse_optional_u32(fields[4]),
        height: parse_optional_u32(fields[5]),
        control_mode: parse_bool_flag(fields[6], "client control mode")?,
        socket_path,
    })
}

fn attach_windows(sessions: &mut [TmuxSession], windows: Vec<TmuxWindow>) {
    let mut by_session = HashMap::<String, Vec<TmuxWindow>>::new();
    for window in windows {
        by_session
            .entry(window.session_id.clone())
            .or_default()
            .push(window);
    }

    for session in sessions {
        if let Some(mut windows) = by_session.remove(&session.id) {
            windows.sort_by_key(|window| window.index);
            session.active_window_id = windows
                .iter()
                .find(|window| window.active)
                .map(|window| window.id.clone());
            session.windows = windows;
        }
    }
}

fn attach_panes(sessions: &mut [TmuxSession], panes: Vec<(String, TmuxPane)>) {
    let mut by_window = HashMap::<String, Vec<TmuxPane>>::new();
    for (_session_id, pane) in panes {
        by_window
            .entry(pane.window_id.clone())
            .or_default()
            .push(pane);
    }

    for session in sessions {
        for window in &mut session.windows {
            if let Some(mut panes) = by_window.remove(&window.id) {
                panes.sort_by_key(|pane| pane.index);
                window.panes = panes;
            }
        }
    }
}

fn action_socket_path(
    params: &TerminalTmuxActionParams,
    context: &TmuxContext,
) -> Result<Option<String>, String> {
    if let Some(socket_path) = params.socket_path.as_deref() {
        let socket_path = socket_path.trim();
        if socket_path.is_empty() {
            return Ok(None);
        }
        validate_socket_path(socket_path)?;
        return Ok(Some(socket_path.to_string()));
    }

    if let Some(current_client) = context.current_client.as_ref() {
        return Ok(current_client.socket_path.clone());
    }

    let available = context
        .sockets
        .iter()
        .filter(|socket| socket.available)
        .collect::<Vec<_>>();
    if available.len() == 1 {
        return Ok(available[0].socket_path.clone());
    }

    Err("tmux socket is ambiguous for this action".to_string())
}

fn action_args(
    params: &TerminalTmuxActionParams,
    context: &TmuxContext,
) -> Result<Vec<String>, String> {
    let target = params.target.as_ref();
    let scroll_lines = scroll_line_count(params);
    match params.action {
        TmuxAction::CloseWindow => Ok(vec![
            "kill-window".to_string(),
            "-t".to_string(),
            preferred_window_id(target, context)?.to_string(),
        ]),
        TmuxAction::ExitTmux => Ok(vec![
            "detach-client".to_string(),
            "-t".to_string(),
            current_client_tty(context)?.to_string(),
        ]),
        TmuxAction::Refresh => Ok(Vec::new()),
        TmuxAction::SelectWindow => Ok(vec![
            "select-window".to_string(),
            "-t".to_string(),
            required_window_id(target)?.to_string(),
        ]),
        TmuxAction::SwitchSession => Ok(vec![
            "switch-client".to_string(),
            "-c".to_string(),
            current_client_tty(context)?.to_string(),
            "-t".to_string(),
            required_session_id(target)?.to_string(),
        ]),
        TmuxAction::ScrollDown => {
            let pane_id = preferred_pane_id(context)?;
            if !pane_is_in_mode(context, pane_id) {
                return Ok(Vec::new());
            }

            Ok(vec![
                "send-keys".to_string(),
                "-X".to_string(),
                "-N".to_string(),
                scroll_lines.clone(),
                "-t".to_string(),
                pane_id.to_string(),
                "scroll-down".to_string(),
            ])
        }
        TmuxAction::ScrollUp => {
            let pane_id = preferred_pane_id(context)?;
            Ok(vec![
                "copy-mode".to_string(),
                "-e".to_string(),
                "-t".to_string(),
                pane_id.to_string(),
                ";".to_string(),
                "send-keys".to_string(),
                "-X".to_string(),
                "-N".to_string(),
                scroll_lines,
                "-t".to_string(),
                pane_id.to_string(),
                "scroll-up".to_string(),
            ])
        }
        TmuxAction::NewWindow => Ok(vec![
            "new-window".to_string(),
            "-t".to_string(),
            format!("{}:", preferred_session_id(target, context)?),
        ]),
    }
}

fn scroll_line_count(params: &TerminalTmuxActionParams) -> String {
    params
        .lines
        .unwrap_or(TMUX_SCROLL_DEFAULT_LINES)
        .clamp(1, TMUX_SCROLL_MAX_LINES)
        .to_string()
}

fn preferred_window_id<'a>(
    target: Option<&'a TmuxActionTarget>,
    context: &'a TmuxContext,
) -> Result<&'a str, String> {
    if let Some(window_id) = target.and_then(|target| target.tmux_window_id.as_deref()) {
        return validate_tmux_id(window_id, '@');
    }

    active_window_id(context).ok_or_else(|| "tmux window target is required".to_string())
}

fn preferred_session_id<'a>(
    target: Option<&'a TmuxActionTarget>,
    context: &'a TmuxContext,
) -> Result<&'a str, String> {
    if let Some(session_id) = target.and_then(|target| target.tmux_session_id.as_deref()) {
        return validate_tmux_id(session_id, '$');
    }

    context
        .current_client
        .as_ref()
        .and_then(|client| client.session_id.as_deref())
        .ok_or_else(|| "tmux session target is required".to_string())
}

fn preferred_pane_id(context: &TmuxContext) -> Result<&str, String> {
    active_pane_id(context).ok_or_else(|| "active tmux pane is required".to_string())
}

fn active_pane_id(context: &TmuxContext) -> Option<&str> {
    let current_session_id = context.current_client.as_ref()?.session_id.as_deref()?;
    context
        .sockets
        .iter()
        .flat_map(|socket| socket.sessions.iter())
        .find(|session| session.id == current_session_id)?
        .windows
        .iter()
        .find(|window| window.active)?
        .panes
        .iter()
        .find(|pane| pane.active)
        .map(|pane| pane.id.as_str())
}

fn pane_is_in_mode(context: &TmuxContext, pane_id: &str) -> bool {
    context
        .sockets
        .iter()
        .flat_map(|socket| socket.sessions.iter())
        .flat_map(|session| session.windows.iter())
        .flat_map(|window| window.panes.iter())
        .find(|pane| pane.id == pane_id)
        .map(|pane| pane.in_mode)
        .unwrap_or(false)
}

fn active_window_id(context: &TmuxContext) -> Option<&str> {
    let current_session_id = context.current_client.as_ref()?.session_id.as_deref()?;
    let session = context
        .sockets
        .iter()
        .flat_map(|socket| socket.sessions.iter())
        .find(|session| session.id == current_session_id)?;

    session
        .windows
        .iter()
        .find(|window| window.active)
        .or_else(|| {
            session
                .active_window_id
                .as_deref()
                .and_then(|active_window_id| {
                    session
                        .windows
                        .iter()
                        .find(|window| window.id == active_window_id)
                })
        })
        .map(|window| window.id.as_str())
}

fn required_window_id(target: Option<&TmuxActionTarget>) -> Result<&str, String> {
    let value = target
        .and_then(|target| target.tmux_window_id.as_deref())
        .ok_or_else(|| "tmux window target is required".to_string())?;
    validate_tmux_id(value, '@')
}

fn required_session_id(target: Option<&TmuxActionTarget>) -> Result<&str, String> {
    let value = target
        .and_then(|target| target.tmux_session_id.as_deref())
        .ok_or_else(|| "tmux session target is required".to_string())?;
    validate_tmux_id(value, '$')
}

fn current_client_tty(context: &TmuxContext) -> Result<&str, String> {
    let tty = context
        .current_client
        .as_ref()
        .map(|client| client.tty.as_str())
        .ok_or_else(|| "tmux client target is required".to_string())?;

    if tty.trim().is_empty() || tty.as_bytes().contains(&0) {
        return Err("invalid tmux client target".to_string());
    }

    Ok(tty)
}

fn validate_tmux_id(value: &str, prefix: char) -> Result<&str, String> {
    let mut chars = value.chars();
    if chars.next() != Some(prefix) || !chars.all(|char| char.is_ascii_digit()) {
        return Err(format!("invalid tmux id: {value}"));
    }

    Ok(value)
}

fn validate_socket_path(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.as_bytes().contains(&0) {
        return Err("invalid tmux socket path".to_string());
    }

    Ok(())
}

fn split_fields(line: &str, expected: usize) -> Result<Vec<&str>, String> {
    let fields = line.split(FIELD_SEPARATOR).collect::<Vec<_>>();
    if fields.len() != expected {
        return Err(format!(
            "expected {expected} tmux fields, got {} in {line:?}",
            fields.len()
        ));
    }

    Ok(fields)
}

fn parse_bool_flag(value: &str, label: &str) -> Result<bool, String> {
    match value {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(format!("invalid {label}: {value}")),
    }
}

fn parse_u32(value: &str, label: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|error| format!("invalid {label}: {error}"))
}

fn parse_optional_u32(value: &str) -> Option<u32> {
    value.parse::<u32>().ok()
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        TerminalTmuxActionParams, TmuxAction, TmuxActionTarget, TmuxMode, action_args,
        parse_clients, parse_panes, parse_sessions, parse_windows, scan_socket, validate_tmux_id,
    };

    #[test]
    fn parses_tmux_state_lines() {
        let mut sessions = parse_sessions("$0|work|1|2\n").expect("session parse");
        let windows = parse_windows("$0|@1|0|shell|1|0|2|layout\n$0|@2|1|logs|0|1|1|layout2\n")
            .expect("window parse");
        let panes = parse_panes(
            "$0|@1|%3|0|1|0|bash|/repo|/dev/pts/1|123|80|24\n\
             $0|@1|%4|1|0|0|vim|/repo|/dev/pts/2|124|80|24\n",
        )
        .expect("pane parse");

        super::attach_windows(&mut sessions, windows);
        super::attach_panes(&mut sessions, panes);

        assert_eq!(sessions[0].active_window_id.as_deref(), Some("@1"));
        assert_eq!(sessions[0].windows.len(), 2);
        assert_eq!(sessions[0].windows[0].panes.len(), 2);
        assert_eq!(sessions[0].windows[0].panes[0].id, "%3");
    }

    #[test]
    fn parses_clients_with_socket_identity() {
        let clients = parse_clients(
            "/dev/pts/8|456|$1|work|120|40|0\n",
            Some("/tmp/tmux-1000/test".to_string()),
        )
        .expect("client parse");

        assert_eq!(clients[0].tty, "/dev/pts/8");
        assert_eq!(clients[0].pid, Some(456));
        assert_eq!(clients[0].session_id.as_deref(), Some("$1"));
        assert_eq!(
            clients[0].socket_path.as_deref(),
            Some("/tmp/tmux-1000/test")
        );
    }

    #[test]
    fn validates_tmux_ids_by_kind() {
        assert_eq!(validate_tmux_id("$12", '$').unwrap(), "$12");
        assert!(validate_tmux_id("@12", '$').is_err());
        assert!(validate_tmux_id("$abc", '$').is_err());
    }

    #[test]
    fn builds_safe_tmux_action_args() {
        let mut context = super::TmuxContext {
            mode: TmuxMode::Attached,
            terminal_session_id: "terminal".to_string(),
            terminal_tty: Some("/dev/pts/8".to_string()),
            current_client: Some(super::TmuxClient {
                tty: "/dev/pts/8".to_string(),
                pid: Some(10),
                session_id: Some("$0".to_string()),
                session_name: "work".to_string(),
                width: Some(80),
                height: Some(24),
                control_mode: false,
                socket_path: None,
            }),
            sockets: vec![super::TmuxSocketState {
                socket_path: None,
                available: true,
                error: None,
                options: super::TmuxOptions::default(),
                sessions: vec![super::TmuxSession {
                    id: "$0".to_string(),
                    name: "work".to_string(),
                    attached: 1,
                    window_count: 1,
                    active_window_id: Some("@0".to_string()),
                    windows: vec![super::TmuxWindow {
                        id: "@0".to_string(),
                        session_id: "$0".to_string(),
                        index: 0,
                        name: "shell".to_string(),
                        active: true,
                        last: false,
                        pane_count: 1,
                        layout: String::new(),
                        panes: vec![super::TmuxPane {
                            id: "%0".to_string(),
                            window_id: "@0".to_string(),
                            index: 0,
                            active: true,
                            in_mode: false,
                            current_command: "bash".to_string(),
                            current_path: "/repo".to_string(),
                            tty: "/dev/pts/9".to_string(),
                            pid: Some(20),
                            width: 80,
                            height: 24,
                        }],
                    }],
                }],
            }],
            generated_at: 1,
        };

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::NewWindow,
            lines: None,
            target: None,
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            ["new-window", "-t", "$0:"]
        );

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::SelectWindow,
            lines: None,
            target: Some(TmuxActionTarget {
                tmux_session_id: None,
                tmux_window_id: Some("@2".to_string()),
            }),
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            ["select-window", "-t", "@2"]
        );

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::SwitchSession,
            lines: None,
            target: Some(TmuxActionTarget {
                tmux_session_id: Some("$1".to_string()),
                tmux_window_id: None,
            }),
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            ["switch-client", "-c", "/dev/pts/8", "-t", "$1"]
        );

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::ScrollUp,
            lines: None,
            target: None,
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            [
                "copy-mode",
                "-e",
                "-t",
                "%0",
                ";",
                "send-keys",
                "-X",
                "-N",
                "3",
                "-t",
                "%0",
                "scroll-up"
            ]
        );

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::ScrollUp,
            lines: Some(5),
            target: None,
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            [
                "copy-mode",
                "-e",
                "-t",
                "%0",
                ";",
                "send-keys",
                "-X",
                "-N",
                "5",
                "-t",
                "%0",
                "scroll-up"
            ]
        );

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::ScrollDown,
            lines: None,
            target: None,
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            Vec::<String>::new()
        );

        context.sockets[0].sessions[0].windows[0].panes[0].in_mode = true;
        assert_eq!(
            action_args(&params, &context).unwrap(),
            ["send-keys", "-X", "-N", "3", "-t", "%0", "scroll-down"]
        );

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::CloseWindow,
            lines: None,
            target: None,
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            ["kill-window", "-t", "@0"]
        );

        let params = TerminalTmuxActionParams {
            session_id: "terminal".to_string(),
            socket_path: None,
            action: TmuxAction::ExitTmux,
            lines: None,
            target: None,
        };
        assert_eq!(
            action_args(&params, &context).unwrap(),
            ["detach-client", "-t", "/dev/pts/8"]
        );
    }

    #[test]
    fn scans_isolated_tmux_socket_when_tmux_is_available() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let socket_name = format!("remux-test-{}", unique_suffix());
        let status = Command::new("tmux")
            .args([
                "-L",
                &socket_name,
                "new-session",
                "-d",
                "-s",
                "remux-test",
                "-n",
                "shell",
                "/bin/sh",
            ])
            .status()
            .expect("spawn tmux");
        if !status.success() {
            return;
        }

        let cleanup = || {
            let _ = Command::new("tmux")
                .args(["-L", &socket_name, "kill-server"])
                .status();
        };

        let socket_path = format!("/tmp/tmux-{}/{}", current_uid_for_test(), socket_name);
        let scanned = scan_socket(Some(&socket_path)).expect("scan isolated socket");
        assert_eq!(scanned.state.sessions.len(), 1);
        assert_eq!(scanned.state.sessions[0].name, "remux-test");
        assert_eq!(scanned.state.sessions[0].windows[0].name, "shell");
        assert!(
            scanned.state.sessions[0].windows[0].panes[0]
                .id
                .starts_with('%')
        );

        cleanup();
    }

    fn unique_suffix() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    }

    fn current_uid_for_test() -> String {
        std::env::var("UID").unwrap_or_else(|_| {
            String::from_utf8(Command::new("id").arg("-u").output().expect("id -u").stdout)
                .expect("utf8 uid")
                .trim()
                .to_string()
        })
    }
}
