# remux-compute

Typed, process-isolated tasks for trusted Remux extension servers.

The crate links task implementations into an extension's existing executable.
Starting a task re-executes that executable in a private worker mode through
`remux workload exec`. Remux owns resource placement; this crate owns typed
input, progress, output, and child lifecycle.

Extension manifests declare resource profiles only. Task names and types live
exclusively in Rust.

```rust,no_run
use remux_compute::{Registry, Task, TaskContext, TaskOptions};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Input(u64);

#[derive(Serialize, Deserialize)]
struct Progress(u64);

#[derive(Serialize, Deserialize)]
struct Output(u64);

struct Double;

impl Task for Double {
    const NAME: &'static str = "example.double";
    const VERSION: u32 = 1;
    type Input = Input;
    type Progress = Progress;
    type Output = Output;

    fn run(
        context: TaskContext<Self::Progress>,
        input: Self::Input,
    ) -> Result<Self::Output, String> {
        context.progress(Progress(input.0))?;
        Ok(Output(input.0 * 2))
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let compute = Registry::new().register::<Double>()?;
    if compute.dispatch_worker_if_requested()? {
        return Ok(());
    }

    let task = compute.spawn::<Double>(
        TaskOptions::new("background", "double:42"),
        Input(42),
    )?;
    let output = task.wait()?;
    assert_eq!(output.0, 84);
    Ok(())
}
```
