use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const MAX_LINE: usize = 1024 * 1024;
const REFUSED: &str = "This plugin answers only the browser's vault calls.";

pub struct Translator {
    next_id: AtomicU64,
}

#[derive(Debug, PartialEq)]
pub enum FromHost {
    Agent(Value),
    Host(Value),
    Nothing,
}

impl Default for Translator {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
        }
    }
}

impl Translator {
    fn request(&self, method: &str, params: Value) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        json!({ "id": id, "method": method, "params": params })
    }

    pub fn hello(&self) -> Value {
        self.request("hello", json!({}))
    }

    pub fn from_agent(&self, message: &Value) -> Option<Value> {
        if let Some(event) = message.get("event").and_then(Value::as_str) {
            let data = message.get("data").cloned().unwrap_or(Value::Null);
            if event == "ready" {
                return Some(self.request("vault.ready", data));
            }
            let mut params = json!({ "event": event, "data": data });
            if let Some(account) = message.get("account") {
                params["account"] = account.clone();
            }
            return Some(self.request("vault.event", params));
        }
        let id = message.get("id")?;
        let result = match message.get("error") {
            Some(error) => json!({ "error": error }),
            None => message.get("result").cloned().unwrap_or(Value::Null),
        };
        Some(self.request("result", json!({ "call": id, "result": result })))
    }

    pub fn from_host(&self, message: &Value) -> FromHost {
        if message.get("id").is_some() && message.get("method").is_none() {
            if let Some(error) = message.get("error") {
                eprintln!("bitwarden-bridge: Ardia refused a message: {error}");
            }
            return FromHost::Nothing;
        }
        let Some(call) = message
            .get("call")
            .filter(|call| call.is_string() || call.is_u64() || call.is_i64())
        else {
            return FromHost::Nothing;
        };
        if message.get("cancel").and_then(Value::as_bool) == Some(true) {
            return FromHost::Agent(json!({ "cancel": call }));
        }
        let from_browser = message
            .get("caller")
            .and_then(|caller| caller.get("kind"))
            .and_then(Value::as_str)
            == Some("host");
        let Some(verb) = message.get("name").and_then(Value::as_str).filter(|_| {
            from_browser && message.get("kind").and_then(Value::as_str) == Some("vault")
        }) else {
            return FromHost::Host(
                self.request("result", json!({ "call": call, "error": REFUSED })),
            );
        };
        let mut params = message.get("input").cloned().unwrap_or_else(|| json!({}));
        let account = params
            .as_object_mut()
            .and_then(|input| input.remove("account"));
        let mut request = json!({ "id": call, "method": verb, "params": params });
        if let Some(account) = account {
            request["account"] = account;
        }
        if let Some(deadline) = message.get("deadline").filter(|deadline| deadline.is_u64()) {
            request["deadline"] = deadline.clone();
        }
        FromHost::Agent(request)
    }
}

fn read_message(reader: &mut impl BufRead) -> Option<Option<Value>> {
    let mut line = Vec::new();
    match (&mut *reader)
        .take(u64::try_from(MAX_LINE + 1).unwrap_or(u64::MAX))
        .read_until(b'\n', &mut line)
    {
        Ok(0) | Err(_) => None,
        Ok(_) if line.len() > MAX_LINE => None,
        Ok(_) => Some(serde_json::from_slice(&line).ok()),
    }
}

fn write_message(writer: &Mutex<impl Write>, message: &Value) -> bool {
    let mut writer = writer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut line = message.to_string();
    line.push('\n');
    writer
        .write_all(line.as_bytes())
        .and_then(|()| writer.flush())
        .is_ok()
}

fn channel() -> Result<UnixStream, String> {
    let fd: i32 = std::env::var("ARDIA_PLUGIN_FD")
        .ok()
        .and_then(|fd| fd.parse().ok())
        .unwrap_or(3);
    if fd < 3 {
        return Err(format!(
            "the channel descriptor must be 3 or more, not {fd}"
        ));
    }
    let mut kind: libc::c_int = 0;
    let mut size = libc::socklen_t::try_from(std::mem::size_of::<libc::c_int>()).unwrap_or(4);
    let found = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            std::ptr::addr_of_mut!(kind).cast(),
            &mut size,
        )
    };
    if found != 0 || kind != libc::SOCK_STREAM {
        return Err(format!("descriptor {fd} isn't a stream socket"));
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err("failed to keep the channel out of the agent".to_string());
    }
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}

fn run() -> Result<(), String> {
    let host = channel()?;
    let agent_path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("rbw-agent");
    let mut agent = Command::new(&agent_path)
        .args(["--embedded", "--accounts"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", agent_path.display()))?;
    let (Some(agent_in), Some(agent_out)) = (agent.stdin.take(), agent.stdout.take()) else {
        return Err("the agent has no pipes".to_string());
    };
    let translator = Arc::new(Translator::default());
    let to_host = Arc::new(Mutex::new(host.try_clone().map_err(|e| e.to_string())?));
    let to_agent = Mutex::new(agent_in);
    if !write_message(&to_host, &translator.hello()) {
        return Err("Ardia closed the channel".to_string());
    }

    let agent_translator = translator.clone();
    let agent_to_host = to_host.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(agent_out);
        while let Some(message) = read_message(&mut reader) {
            let Some(message) = message else { continue };
            if let Some(forward) = agent_translator.from_agent(&message) {
                if !write_message(&agent_to_host, &forward) {
                    break;
                }
            }
        }
        eprintln!("bitwarden-bridge: the agent stopped");
        std::process::exit(1);
    });

    let mut reader = BufReader::new(host);
    while let Some(message) = read_message(&mut reader) {
        let Some(message) = message else { continue };
        match translator.from_host(&message) {
            FromHost::Agent(request) => {
                if !write_message(&to_agent, &request) {
                    break;
                }
            }
            FromHost::Host(reply) => {
                write_message(&to_host, &reply);
            }
            FromHost::Nothing => {}
        }
    }
    drop(to_agent);
    let _ = agent.wait();
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("bitwarden-bridge: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn agent_request(translator: &Translator, message: Value) -> Value {
        match translator.from_host(&message) {
            FromHost::Agent(request) => request,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_browser_vault_call_becomes_an_agent_request_with_its_account_taken_out_of_the_input() {
        let translator = Translator::default();
        let call = json!({
            "call": "c1", "kind": "vault", "name": "fill", "caller": {"kind": "host"},
            "input": {"account": "Profile_201", "id": "x", "origin": "https://github.com"}, "deadline": 5000,
        });
        assert_eq!(
            agent_request(&translator, call),
            json!({"id": "c1", "method": "fill", "params": {"id": "x", "origin": "https://github.com"}, "account": "Profile_201", "deadline": 5000})
        );
        assert_eq!(
            agent_request(
                &translator,
                json!({"call": 7, "kind": "vault", "name": "accounts", "caller": {"kind": "host"}})
            ),
            json!({"id": 7, "method": "accounts", "params": {}})
        );
    }

    #[test]
    fn only_the_browser_may_call_the_vault() {
        let translator = Translator::default();
        for caller in ["plugin", "cli", "command"] {
            let call = json!({"call": "c2", "kind": "vault", "name": "fill", "caller": {"kind": caller}, "input": {}});
            match translator.from_host(&call) {
                FromHost::Host(reply) => {
                    assert_eq!(reply["method"], "result");
                    assert_eq!(reply["params"], json!({"call": "c2", "error": REFUSED}));
                }
                other => panic!("{caller}: {other:?}"),
            }
        }
        let tool = json!({"call": "c3", "tool": "x", "caller": {"kind": "host"}});
        assert!(
            matches!(translator.from_host(&tool), FromHost::Host(_)),
            "a tool call isn't a vault call"
        );
    }

    #[test]
    fn cancels_reach_the_agent_and_replies_to_the_bridge_stop_here() {
        let translator = Translator::default();
        assert_eq!(
            translator.from_host(&json!({"call": "c4", "cancel": true})),
            FromHost::Agent(json!({"cancel": "c4"}))
        );
        assert_eq!(
            translator.from_host(&json!({"id": 1, "result": {"ok": true}})),
            FromHost::Nothing
        );
        assert_eq!(
            translator.from_host(&json!({"id": 2, "error": "nope"})),
            FromHost::Nothing
        );
        assert_eq!(
            translator.from_host(&json!({"call": {}, "kind": "vault"})),
            FromHost::Nothing
        );
    }

    #[test]
    fn the_agent_speaks_to_ardia_through_requests_and_a_verb_error_keeps_its_code() {
        let translator = Translator::default();
        let hello = translator.hello();
        assert_eq!(hello["method"], "hello");
        let ready = translator
            .from_agent(&json!({"event": "ready", "data": {"protocol": 1}}))
            .unwrap();
        assert_eq!(
            (ready["method"].clone(), ready["params"].clone()),
            (json!("vault.ready"), json!({"protocol": 1}))
        );
        assert_ne!(ready["id"], hello["id"], "each request has its own id");
        let event = translator
            .from_agent(&json!({"event": "state", "account": "work", "data": {"state": "locked"}}))
            .unwrap();
        assert_eq!(event["method"], "vault.event");
        assert_eq!(
            event["params"],
            json!({"event": "state", "data": {"state": "locked"}, "account": "work"})
        );
        let answer = translator
            .from_agent(&json!({"id": "c1", "result": {"values": {}}}))
            .unwrap();
        assert_eq!(
            answer["params"],
            json!({"call": "c1", "result": {"values": {}}})
        );
        let error = translator.from_agent(&json!({"id": "c1", "error": {"code": "locked", "message": "The vault is locked."}})).unwrap();
        assert_eq!(error["params"]["result"]["error"]["code"], "locked");
        assert_eq!(translator.from_agent(&json!({"nothing": true})), None);
    }
}
