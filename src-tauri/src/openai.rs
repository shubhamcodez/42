//! OpenAI API client: file upload, Responses API (documents), and Chat Completions (text-only).

use std::fs;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Deserialize)]
struct OpenAIFileResponse {
    id: String,
}

// --- Responses API (for document upload) ---
#[derive(Debug, Serialize)]
struct ResponsesRequest {
    model: String,
    input: Vec<ResponsesInputItem>,
}

#[derive(Debug, Serialize)]
struct ResponsesInputItem {
    role: String,
    content: Vec<JsonValue>,
}

// --- Chat Completions API (text-only, no files) ---
#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessageRequest>,
}

#[derive(Debug, Serialize)]
struct ChatMessageRequest {
    role: String,
    content: JsonValue,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    #[allow(dead_code)]
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

fn path_for_reading(s: &str) -> &str {
    s.strip_prefix("file://").unwrap_or(s)
}

/// Upload a file to OpenAI Files API (purpose=user_data) for document/vision models.
/// Returns the file ID on success.
async fn upload_file(
    client: &Client,
    api_key: &str,
    path: &str,
) -> Result<String, String> {
    let path_clean = path_for_reading(path);
    let file_bytes = fs::read(path_clean).map_err(|e| format!("Read file: {}", e))?;
    let filename = std::path::Path::new(path_clean)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document");
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename.to_string())
        .mime_str(
            mime_guess::from_path(path_clean)
                .first_raw()
                .unwrap_or("application/octet-stream"),
        )
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("purpose", "user_data");
    let res = client
        .post("https://api.openai.com/v1/files")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("OpenAI file upload {}: {}", status, text));
    }
    let file_res: OpenAIFileResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(file_res.id)
}

#[allow(dead_code)]
fn read_attachment_paths(paths: &[String]) -> String {
    let mut parts = Vec::new();
    for path in paths {
        let path_clean = path_for_reading(path);
        if let Ok(content) = fs::read_to_string(path_clean) {
            let name = std::path::Path::new(path_clean)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");
            parts.push(format!("[Contents of {}]\n{}", name, content));
        }
    }
    parts.join("\n\n")
}

/// Extract assistant text from Responses API output array.
/// Handles output as array of messages with content[].type == "output_text".
fn extract_output_text(output: &[JsonValue]) -> String {
    let mut parts = Vec::new();
    for item in output {
        let obj = match item.as_object() {
            Some(o) => o,
            None => continue,
        };
        let content = match obj.get("content").and_then(|c| c.as_array()) {
            Some(c) => c,
            None => continue,
        };
        for part in content {
            let part_obj = match part.as_object() {
                Some(o) => o,
                None => continue,
            };
            if part_obj.get("type").and_then(|t| t.as_str()) != Some("output_text") {
                continue;
            }
            if let Some(text) = part_obj.get("text").and_then(|t| t.as_str()) {
                parts.push(text);
            }
        }
    }
    let reply = parts.join("").trim().to_string();
    if reply.is_empty() {
        "No text in response.".to_string()
    } else {
        reply
    }
}

/// Send a chat request. With attachments: uses Responses API (document upload).
/// Without: uses Chat Completions API.
pub async fn chat(
    api_key: &str,
    message: String,
    attachment_paths: Option<Vec<String>>,
) -> Result<String, String> {
    let client = Client::new();

    if let Some(ref paths) = attachment_paths {
        if !paths.is_empty() {
            return responses_with_files(&client, api_key, &message, paths).await;
        }
    }

    chat_completion_only(&client, api_key, message).await
}

/// Use Responses API with uploaded files (supports PDF, docx, etc.).
async fn responses_with_files(
    client: &Client,
    api_key: &str,
    message: &str,
    paths: &[String],
) -> Result<String, String> {
    let mut file_ids = Vec::with_capacity(paths.len());
    for path in paths {
        let id = upload_file(client, api_key, path)
            .await
            .map_err(|e| format!("Upload failed for {}: {}", path, e))?;
        file_ids.push(id);
    }

    let mut content: Vec<JsonValue> = file_ids
        .into_iter()
        .map(|file_id| serde_json::json!({ "type": "input_file", "file_id": file_id }))
        .collect();
    let text = message.trim();
    if !text.is_empty() {
        content.push(serde_json::json!({ "type": "input_text", "text": text }));
    } else {
        content.push(serde_json::json!({
            "type": "input_text",
            "text": "Please summarize or answer based on the attached documents."
        }));
    }

    let body = ResponsesRequest {
        model: "gpt-4o".to_string(),
        input: vec![ResponsesInputItem {
            role: "user".to_string(),
            content,
        }],
    };

    let res = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let raw = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("API error {}: {}", status, raw));
    }

    let json: JsonValue = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let empty: &[JsonValue] = &[];
    let output = json
        .get("output")
        .and_then(|o| o.as_array())
        .map_or(empty, |a| a.as_slice());
    Ok(extract_output_text(output))
}

/// Text-only chat via Chat Completions API.
async fn chat_completion_only(
    client: &Client,
    api_key: &str,
    message: String,
) -> Result<String, String> {
    let body = ChatRequest {
        model: "gpt-4o-mini".to_string(),
        messages: vec![ChatMessageRequest {
            role: "user".to_string(),
            content: JsonValue::String(message),
        }],
    };

    let res = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status, text));
    }

    let chat: ChatResponse = res.json().await.map_err(|e| e.to_string())?;
    let reply = chat
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_else(|| "No response.".to_string());

    Ok(reply)
}

/// Classification result: is the user asking for a computer task (agent) or normal chat?
#[derive(Debug, serde::Deserialize)]
pub struct TaskClassification {
    pub is_task: bool,
    pub goal: Option<String>,
}

const TASK_CLASSIFY_SYSTEM: &str = r#"You are a classifier. The user is talking to an assistant that can either (1) chat normally (answer questions, summarize, discuss) or (2) perform actions on the computer (open URLs, navigate, click, fill forms, etc.).

If the user is clearly asking the assistant to DO something on the computer (e.g. "open example.com", "go to google and search for X", "navigate to that page"), reply with a JSON object only, no other text: {"is_task": true, "goal": "one clear sentence describing the task"}.

Otherwise (general question, chat, "what is X", "summarize this", "hello", or unclear), reply with: {"is_task": false, "goal": null}.

Output ONLY the JSON object, no markdown or explanation."#;

/// Classify user message as task (run agent) or normal chat. Returns (is_task, goal if task).
pub async fn classify_task(api_key: &str, user_message: &str) -> Result<TaskClassification, String> {
    let user_message = user_message.trim();
    if user_message.is_empty() {
        return Ok(TaskClassification {
            is_task: false,
            goal: None,
        });
    }
    let raw = chat_with_system(api_key, TASK_CLASSIFY_SYSTEM, user_message).await?;
    let raw = raw.trim();
    // Extract JSON: model might wrap in ```json ... ``` or output raw
    let json_str = raw
        .strip_prefix("```json")
        .or_else(|| raw.strip_prefix("```"))
        .and_then(|s| s.strip_suffix("```"))
        .map(|s| s.trim())
        .unwrap_or(raw);
    let classification: TaskClassification =
        serde_json::from_str(json_str).map_err(|e| format!("Parse classification: {} (raw: {})", e, raw))?;
    Ok(classification)
}

/// Chat with a system prompt (e.g. for planning). Returns assistant reply.
pub async fn chat_with_system(
    api_key: &str,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, String> {
    let client = Client::new();
    let body = ChatRequest {
        model: "gpt-4o-mini".to_string(),
        messages: vec![
            ChatMessageRequest {
                role: "system".to_string(),
                content: JsonValue::String(system_prompt.to_string()),
            },
            ChatMessageRequest {
                role: "user".to_string(),
                content: JsonValue::String(user_message.to_string()),
            },
        ],
    };
    let res = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status, text));
    }
    let chat: ChatResponse = res.json().await.map_err(|e| e.to_string())?;
    chat.choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "No response.".to_string())
}

// --- Desktop agent: vision (screenshot + goal -> next action) ---

/// Parsed action from the vision model for desktop control.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DesktopAction {
    /// "click" | "type" | "scroll" | "done"
    pub action: String,
    /// Screen x for click (0 = left).
    pub x: Option<i32>,
    /// Screen y for click (0 = top). On Windows taskbar is usually at bottom.
    pub y: Option<i32>,
    /// Text to type (for action "type").
    pub text: Option<String>,
    /// Scroll amount (for action "scroll"), positive = down.
    #[serde(default)]
    pub scroll_amount: Option<i32>,
    /// Human-readable description of what the model is doing.
    pub description: Option<String>,
    /// Brief reasoning: what you see on screen and why you chose this action (shown to user).
    pub thought: Option<String>,
}

const DESKTOP_VISION_SYSTEM: &str = r#"You control the user's desktop by looking at a screenshot and deciding the next mouse/keyboard action.

RULES:
- Goal is given below. Perform ONE step at a time.
- On Windows: taskbar is usually at the BOTTOM of the screen. Icons (Chrome, etc.) are on the taskbar. The search bar (Type here to search) is on the taskbar, often left or center.
- If the app icon (e.g. Chrome) is visible on the taskbar: reply with action "click" and the approximate (x,y) of that icon (center of the icon).
- If the app is NOT on the taskbar: use action "click" to click the taskbar search box first (give its approximate x,y), then on the next step you'll see the search open and use action "type" with the app name (e.g. "Chrome"), then click the search result.
- Coordinates: (0,0) is top-left. x increases right, y increases down. Give pixel coordinates.
- Reply with ONLY a JSON object, no markdown or other text. Include "thought": a 1–2 sentence explanation of what you see on screen and why you are taking this action (e.g. "I see the taskbar at the bottom. The Chrome icon is visible; I'll click it."). Format:
{"action": "click"|"type"|"scroll"|"done", "x": number or null, "y": number or null, "text": string or null, "scroll_amount": number or null, "description": "what you're doing", "thought": "what you see and why you're doing this"}
- Use "done" when the goal is achieved (e.g. Chrome window is open). For "done", set thought to a brief summary (e.g. "Chrome window is now open.").
- Use "type" to type text (e.g. in search box). Use "click" to click at (x,y). Use "scroll" with scroll_amount (positive = scroll down)."#;

/// Call vision model with screenshot (base64 PNG) and goal; returns one desktop action.
pub async fn vision_desktop_action(
    api_key: &str,
    image_base64: &str,
    goal: &str,
    step: u32,
    last_result: Option<&str>,
) -> Result<DesktopAction, String> {
    let user_content = serde_json::json!([
        {
            "type": "text",
            "text": format!(
                "Goal: {}. Step {}. {} Reply with ONLY the JSON object.",
                goal,
                step,
                last_result
                    .map(|r| format!("Last action result: {}", r))
                    .unwrap_or_else(|| "First step.".to_string())
            )
        },
        {
            "type": "image_url",
            "image_url": { "url": format!("data:image/png;base64,{}", image_base64) }
        }
    ]);

    let client = Client::new();
    let body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [
            { "role": "system", "content": DESKTOP_VISION_SYSTEM },
            { "role": "user", "content": user_content }
        ],
        "max_tokens": 500
    });

    let res = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Vision API error {}: {}", status, text));
    }

    let chat: ChatResponse = res.json().await.map_err(|e| e.to_string())?;
    let raw = chat
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default();
    let raw = raw.trim();
    let json_str = raw
        .strip_prefix("```json")
        .or_else(|| raw.strip_prefix("```"))
        .and_then(|s| s.strip_suffix("```"))
        .map(|s| s.trim())
        .unwrap_or(raw);
    let action: DesktopAction =
        serde_json::from_str(json_str).map_err(|e| format!("Parse desktop action: {} (raw: {})", e, raw))?;
    Ok(action)
}
