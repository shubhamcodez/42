//! Chat log state and commands: JSON logs in chats/ with messages and agent_session_ids.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::storage;

/// In-memory state for the current chat session (path to the active log file).
#[derive(Default)]
pub struct ChatLogState {
    pub current_path: Mutex<Option<PathBuf>>,
}

const CHAT_EXT: &str = "json";
const CHAT_TITLE_MAX_LEN: usize = 48;

/// On-disk format for a chat log in chats/.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatLogFile {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub messages: Vec<ChatLogMessage>,
    #[serde(default)]
    pub agent_session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatLogMessage {
    pub role: String,
    pub content: String,
}

fn chat_path(chat_id: &str) -> Result<PathBuf, String> {
    Ok(storage::chats_dir()?.join(format!("{}.{}", chat_id, CHAT_EXT)))
}

fn title_from_first_user_message(messages: &[ChatLogMessage]) -> String {
    for m in messages {
        if m.role == "user" {
            let t = m.content.trim();
            if t.is_empty() {
                return "New chat".to_string();
            }
            return if t.len() > CHAT_TITLE_MAX_LEN {
                format!("{}…", t.chars().take(CHAT_TITLE_MAX_LEN).collect::<String>())
            } else {
                t.to_string()
            };
        }
    }
    "New chat".to_string()
}

fn load_chat_file(path: &std::path::Path) -> Result<ChatLogFile, String> {
    let s = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut file: ChatLogFile = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if file.title.is_empty() {
        file.title = title_from_first_user_message(&file.messages);
    }
    Ok(file)
}

fn save_chat_file(path: &std::path::Path, file: &ChatLogFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn append_chat_log(
    state: tauri::State<ChatLogState>,
    role: String,
    content: String,
) -> Result<(), String> {
    let role = match role.as_str() {
        "user" => "user",
        "assistant" => "assistant",
        _ => return Err("role must be 'user' or 'assistant'".to_string()),
    };

    let mut path_guard = state.current_path.lock().map_err(|e| e.to_string())?;

    if path_guard.is_none() {
        let dir = storage::chats_dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        *path_guard = Some(dir.join(format!("{}.{}", ts, CHAT_EXT)));
    }

    let path = path_guard.as_ref().unwrap().clone();
    drop(path_guard);

    let mut file = if path.exists() {
        load_chat_file(&path)?
    } else {
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        ChatLogFile {
            id: id.clone(),
            title: String::new(),
            messages: Vec::new(),
            agent_session_ids: Vec::new(),
        }
    };

    file.messages.push(ChatLogMessage {
        role: role.to_string(),
        content: content.trim_end().to_string(),
    });
    if file.title.is_empty() && role == "user" {
        file.title = title_from_first_user_message(&file.messages);
    }

    save_chat_file(&path, &file)
}

/// Add an agent session id to a chat's log (called when creating a session from a chat).
pub fn add_agent_session_to_chat(chat_id: &str, session_id: &str) -> Result<(), String> {
    let path = chat_path(chat_id)?;
    if !path.exists() {
        return Ok(());
    }
    let mut file = load_chat_file(&path)?;
    if !file.agent_session_ids.contains(&session_id.to_string()) {
        file.agent_session_ids.push(session_id.to_string());
        save_chat_file(&path, &file)?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ChatEntry {
    pub id: String,
    pub title: String,
}

#[tauri::command]
pub fn list_chats() -> Result<Vec<ChatEntry>, String> {
    let dir = storage::chats_dir()?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<ChatEntry> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some(CHAT_EXT) {
                return None;
            }
            let id = p.file_stem().and_then(|s| s.to_str())?.to_string();
            let title = load_chat_file(&p)
                .map(|f| {
                    if f.title.is_empty() {
                        title_from_first_user_message(&f.messages)
                    } else {
                        f.title
                    }
                })
                .unwrap_or_else(|_| "New chat".to_string());
            Some(ChatEntry { id, title })
        })
        .collect();
    entries.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(entries)
}

/// Set the active chat (so future appends go to this chat). Used when user selects a chat.
#[tauri::command]
pub fn set_current_chat(
    state: tauri::State<ChatLogState>,
    chat_id: String,
) -> Result<(), String> {
    let path = chat_path(&chat_id)?;
    let mut path_guard = state.current_path.lock().map_err(|e| e.to_string())?;
    *path_guard = Some(path);
    Ok(())
}

/// Get the current chat id (file stem of current log path), if any.
#[tauri::command]
pub fn get_current_chat_id(state: tauri::State<ChatLogState>) -> Result<Option<String>, String> {
    let path_guard = state.current_path.lock().map_err(|e| e.to_string())?;
    Ok(path_guard
        .as_ref()
        .and_then(|p| p.file_stem())
        .and_then(|s| s.to_str())
        .map(String::from))
}

#[derive(serde::Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Read all messages in a chat (for displaying when user selects a chat).
#[tauri::command]
pub fn read_chat_log(chat_id: String) -> Result<Vec<ChatMessage>, String> {
    let path = chat_path(&chat_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = load_chat_file(&path)?;
    Ok(file
        .messages
        .into_iter()
        .map(|m| ChatMessage {
            role: m.role,
            content: m.content,
        })
        .collect())
}
