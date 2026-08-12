# Feed/session public compatibility contract

This addendum is a governing owner contract for the benchmark. The implementation
may add private helpers and internal structure, but it must preserve these public
entry points and their exact argument/return shapes for existing Ledger callers.

```rust
impl<S> LedgerSessionBuilder<S>
where
    S: store::RemoteStore + 'static,
{
    pub fn new(store: Arc<Store<S>>) -> Result<Self, LedgerError>;

    pub fn es_replay(
        &mut self,
        raw_object_id: StoreObjectId,
    ) -> Result<EsReplayCells, LedgerError>;

    pub async fn start(self) -> Result<LedgerSessionHandle, LedgerError>;
}

impl EsReplayCells {
    pub fn register(cache: &Cache) -> Result<Self, LedgerError>;
}
```

The payload/helper types and module re-exports explicitly named by the main feed
specification remain public at the documented paths. Do not replace the methods
above with an options-only constructor or another API that requires callers to
change.
