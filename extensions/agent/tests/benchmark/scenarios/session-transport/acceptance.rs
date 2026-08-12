#[cfg(test)]
mod benchmark_session_transport_acceptance {
    use super::LedgerRemux;
    use crate::error::{DOMAIN_ERROR, INVALID_PARAMS};
    use crate::rpc::{OutboundMessage, Request};
    use async_trait::async_trait;
    use ledger::feed::es_replay::{
        encode_event_store, ES_MBO_EVENT_STORE_FILE_NAME, ES_MBO_EVENT_STORE_KIND,
        ES_MBO_EVENT_STORE_VERSION, RAW_DATABENTO_DBN_ZST_KIND,
    };
    use ledger::market::{
        build_batches, BookAction, BookSide, EsMboEvent, EsMboEventStore, MarketDay, PriceTicks,
    };
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use store::{
        ObjectMetadata, RegisterFileRequest, RemoteObject, RemoteStore, Store, StoreConfig,
        StoreObjectId, StoreObjectRole,
    };
    use tempfile::{tempdir, TempDir};
    use tokio::io::AsyncWriteExt;
    use tokio::sync::mpsc;
    use tokio::time::{timeout, Duration};

    const OPEN: &str = "remux/ledger/session/open";
    const CLOSE: &str = "remux/ledger/session/close";
    const STATUS: &str = "remux/ledger/session/status";
    const PLAY: &str = "remux/ledger/session/play";
    const SEEK: &str = "remux/ledger/session/seek";
    const BARS: &str = "remux/ledger/session/bars";
    const CLOSED: &str = "remux/ledger/session/closed";
    const CLOCK: &str = "remux/ledger/session/clock";
    const FEED: &str = "remux/ledger/session/feed";
    const BARS_FRAME: &str = "remux/ledger/session/barsFrame";

    #[derive(Clone, Default)]
    struct TestRemote {
        objects: Arc<Mutex<HashMap<String, (Vec<u8>, ObjectMetadata)>>>,
    }

    #[async_trait]
    impl RemoteStore for TestRemote {
        async fn put_path(
            &self,
            key: &str,
            path: &Path,
            metadata: &ObjectMetadata,
        ) -> anyhow::Result<RemoteObject> {
            self.put_bytes(key, &tokio::fs::read(path).await?, metadata)
                .await
        }

        async fn get_to_path(&self, key: &str, dest: &Path) -> anyhow::Result<RemoteObject> {
            let (bytes, metadata) = self
                .objects
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("missing object {key}"))?;
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let mut file = tokio::fs::File::create(dest).await?;
            file.write_all(&bytes).await?;
            file.sync_all().await?;
            Ok(remote_object(key, bytes.len() as u64, &metadata))
        }

        async fn head(&self, key: &str) -> anyhow::Result<Option<RemoteObject>> {
            Ok(self
                .objects
                .lock()
                .unwrap()
                .get(key)
                .map(|(bytes, metadata)| remote_object(key, bytes.len() as u64, metadata)))
        }

        async fn delete(&self, key: &str) -> anyhow::Result<()> {
            self.objects.lock().unwrap().remove(key);
            Ok(())
        }

        async fn put_bytes(
            &self,
            key: &str,
            bytes: &[u8],
            metadata: &ObjectMetadata,
        ) -> anyhow::Result<RemoteObject> {
            self.objects
                .lock()
                .unwrap()
                .insert(key.to_string(), (bytes.to_vec(), metadata.clone()));
            Ok(remote_object(key, bytes.len() as u64, metadata))
        }

        async fn get_bytes(&self, key: &str) -> anyhow::Result<Vec<u8>> {
            self.objects
                .lock()
                .unwrap()
                .get(key)
                .map(|(bytes, _)| bytes.clone())
                .ok_or_else(|| anyhow::anyhow!("missing object {key}"))
        }

        async fn list_keys(&self, prefix: &str) -> anyhow::Result<Vec<String>> {
            Ok(self
                .objects
                .lock()
                .unwrap()
                .keys()
                .filter(|key| key.starts_with(prefix))
                .cloned()
                .collect())
        }

        fn bucket(&self) -> &str {
            "benchmark-bucket"
        }
    }

    fn remote_object(key: &str, size_bytes: u64, metadata: &ObjectMetadata) -> RemoteObject {
        RemoteObject {
            bucket: "benchmark-bucket".to_string(),
            key: key.to_string(),
            size_bytes,
            sha256: Some(metadata.sha256.clone()),
            etag: None,
            metadata: metadata.user_metadata.clone(),
        }
    }

    fn fixture() -> (
        TempDir,
        LedgerRemux<TestRemote>,
        mpsc::Receiver<OutboundMessage>,
    ) {
        let data = tempdir().unwrap();
        let store = Store::open(
            data.path(),
            StoreConfig {
                local_max_bytes: 1024 * 1024,
            },
            Arc::new(TestRemote::default()),
        )
        .unwrap();
        let (output_tx, output_rx) = mpsc::channel(128);
        (data, LedgerRemux::new(store, output_tx), output_rx)
    }

    async fn call(
        methods: &LedgerRemux<TestRemote>,
        method: &str,
        params: Value,
    ) -> Result<Value, crate::error::RpcError> {
        methods
            .handle(Request {
                method: method.to_string(),
                params,
            })
            .await
    }

    async fn prepared_day(
        methods: &LedgerRemux<TestRemote>,
        data: &TempDir,
        events: Vec<EsMboEvent>,
    ) -> StoreObjectId {
        let nonce = store::now_ns();
        let raw_path = data.path().join(format!("raw-{nonce}.dbn.zst"));
        tokio::fs::write(&raw_path, format!("benchmark raw {nonce}"))
            .await
            .unwrap();
        let raw = methods
            .store
            .register_file(RegisterFileRequest {
                path: &raw_path,
                role: StoreObjectRole::Raw,
                kind: RAW_DATABENTO_DBN_ZST_KIND.to_string(),
                file_name: Some("raw.dbn.zst".to_string()),
                format: Some("dbn.zst".to_string()),
                media_type: None,
                lineage: Vec::new(),
                metadata_json: json!({}),
            })
            .await
            .unwrap();

        let event_store = EsMboEventStore {
            batches: build_batches(&events),
            events,
        };
        let artifact_path = data.path().join(format!("artifact-{nonce}.bin"));
        tokio::fs::write(&artifact_path, encode_event_store(&event_store))
            .await
            .unwrap();
        let first = event_store
            .events
            .first()
            .map(|event| event.ts_event_ns)
            .unwrap_or_default();
        let last = event_store
            .events
            .last()
            .map(|event| event.ts_event_ns)
            .unwrap_or_default();
        methods
            .store
            .register_file(RegisterFileRequest {
                path: &artifact_path,
                role: StoreObjectRole::Artifact,
                kind: ES_MBO_EVENT_STORE_KIND.to_string(),
                file_name: Some(ES_MBO_EVENT_STORE_FILE_NAME.to_string()),
                format: Some("ledger.es_mbo_event_store.v1".to_string()),
                media_type: None,
                lineage: vec![raw.id.clone()],
                metadata_json: json!({
                    "artifact": "es_mbo_event_store",
                    "version": ES_MBO_EVENT_STORE_VERSION,
                    "raw_object_id": raw.id.to_string(),
                    "market_day": MarketDay::parse("2026-03-10").unwrap().to_string(),
                    "event_count": event_store.events.len() as u64,
                    "batch_count": event_store.batches.len() as u64,
                    "first_ts_event_ns": first.to_string(),
                    "last_ts_event_ns": last.to_string(),
                }),
            })
            .await
            .unwrap();
        raw.id
    }

    fn trade(ts_event_ns: u64, sequence: u64, price: i64) -> EsMboEvent {
        EsMboEvent {
            ts_event_ns,
            ts_recv_ns: ts_event_ns,
            sequence,
            action: BookAction::Trade,
            side: Some(if sequence % 2 == 0 {
                BookSide::Ask
            } else {
                BookSide::Bid
            }),
            price_ticks: Some(PriceTicks(price)),
            size: sequence as u32,
            order_id: sequence,
            flags: 0,
            is_last: true,
        }
    }

    async fn wait_notification(
        output: &mut mpsc::Receiver<OutboundMessage>,
        method: &str,
        mut predicate: impl FnMut(&Value) -> bool,
    ) -> Value {
        timeout(Duration::from_secs(3), async {
            loop {
                match output.recv().await.expect("outbound channel remains open") {
                    OutboundMessage::Json(value)
                        if value["method"] == method && predicate(&value["params"]) =>
                    {
                        return value["params"].clone();
                    }
                    OutboundMessage::Json(_) | OutboundMessage::Flush(_) => {}
                }
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn visible_rpc_contract_validates_before_replacement() {
        let (data, methods, _output) = fixture();
        let raw = prepared_day(&methods, &data, vec![trade(100, 1, 100)]).await;
        let opened = call(
            &methods,
            OPEN,
            json!({ "rawId": raw.to_string(), "projections": ["bars:60s"] }),
        )
        .await
        .unwrap();
        assert_eq!(opened["sessionId"], "session-1");
        assert_eq!(opened["projections"], json!([{ "spec": "bars:1m" }]));

        let duplicate = call(
            &methods,
            OPEN,
            json!({ "rawId": raw.to_string(), "projections": ["bars:60s", "bars:1m"] }),
        )
        .await
        .unwrap_err();
        assert_eq!(duplicate.code, INVALID_PARAMS);
        let unknown = call(
            &methods,
            OPEN,
            json!({ "rawId": format!("sha256-{}", "0".repeat(64)), "projections": [] }),
        )
        .await
        .unwrap_err();
        assert_eq!(unknown.message, "objectNotFound");
        assert_eq!(
            call(&methods, STATUS, json!({ "sessionId": "session-1" }))
                .await
                .unwrap()["sessionId"],
            "session-1"
        );
        call(&methods, CLOSE, json!({ "sessionId": "session-1" }))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn push_pull_regression_and_controls_share_the_wire_contract() {
        let (data, methods, mut output) = fixture();
        let raw = prepared_day(
            &methods,
            &data,
            vec![trade(100, 1, 100), trade(1_500_000_000, 2, 105), trade(2_500_000_000, 3, 99)],
        )
        .await;
        call(
            &methods,
            OPEN,
            json!({ "rawId": raw.to_string(), "projections": ["bars:1s"] }),
        )
        .await
        .unwrap();
        call(
            &methods,
            SEEK,
            json!({ "sessionId": "session-1", "sessionNs": "2500000000" }),
        )
        .await
        .unwrap();
        wait_notification(&mut output, CLOCK, |params| {
            params["sessionId"] == "session-1"
                && params["clock"]["sessionNowNs"] == "2500000000"
        })
        .await;
        wait_notification(&mut output, FEED, |params| {
            params["sessionId"] == "session-1" && params["cursor"]["ended"] == true
        })
        .await;
        let first = wait_notification(&mut output, BARS_FRAME, |params| {
            params["sessionId"] == "session-1" && params["total"] == 2
        })
        .await;
        assert_eq!(first["from"], 0);
        let pulled = call(
            &methods,
            BARS,
            json!({ "sessionId": "session-1", "spec": "bars:1s", "from": 1 }),
        )
        .await
        .unwrap();
        assert_eq!(pulled["from"], 1);
        assert_eq!(pulled["bars"].as_array().unwrap().len(), 1);

        call(
            &methods,
            SEEK,
            json!({ "sessionId": "session-1", "sessionNs": "1500000000" }),
        )
        .await
        .unwrap();
        let regressed = wait_notification(&mut output, BARS_FRAME, |params| {
            params["sessionId"] == "session-1"
                && params["epoch"].as_u64().is_some_and(|epoch| epoch > 0)
                && params["total"] == 1
        })
        .await;
        assert_eq!(regressed["from"], 0);
        assert_eq!(call(&methods, PLAY, json!({ "sessionId": "session-1" })).await.unwrap(), json!({ "ok": true }));
        call(&methods, CLOSE, json!({ "sessionId": "session-1" }))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replacement_and_close_make_old_ids_terminal() {
        let (data, methods, mut output) = fixture();
        let first_raw = prepared_day(&methods, &data, vec![trade(100, 1, 100)]).await;
        let second_raw = prepared_day(&methods, &data, vec![trade(200, 2, 200)]).await;
        call(&methods, OPEN, json!({ "rawId": first_raw.to_string(), "projections": [] }))
            .await
            .unwrap();
        let second = call(&methods, OPEN, json!({ "rawId": second_raw.to_string(), "projections": [] }))
            .await
            .unwrap();
        assert_eq!(second["sessionId"], "session-2");
        assert_eq!(second["replaced"], "session-1");
        wait_notification(&mut output, CLOSED, |params| {
            params["sessionId"] == "session-1" && params["reason"] == "replaced"
        })
        .await;
        let stale = call(&methods, STATUS, json!({ "sessionId": "session-1" }))
            .await
            .unwrap_err();
        assert_eq!(stale.code, DOMAIN_ERROR);
        call(&methods, CLOSE, json!({ "sessionId": "session-2" }))
            .await
            .unwrap();
        wait_notification(&mut output, CLOSED, |params| {
            params["sessionId"] == "session-2" && params["reason"] == "closed"
        })
        .await;
        let closed = call(&methods, STATUS, json!({ "sessionId": "session-2" }))
            .await
            .unwrap_err();
        assert_eq!(closed.code, DOMAIN_ERROR);
    }
}
