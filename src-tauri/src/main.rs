// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Emitter;

mod agent;
mod chat_log;
mod dialog;
mod env;
mod openai;
mod storage;
mod window;

#[tauri::command]
async fn chatbot_response(
    message: String,
    attachment_paths: Option<Vec<String>>,
) -> Result<String, String> {
    env::load_env();
    let api_key = std::env::var("OPENAI_API_KEY")
        .map_err(|_| "OPENAI_API_KEY not set. Add it to a .env file in the project root.")?;
    openai::chat(&api_key, message, attachment_paths).await
}

/// Single entry point: classify message as task or chat, then run agent or chatbot.
#[tauri::command]
async fn send_message(
    window: tauri::Window,
    message: String,
    attachment_paths: Option<Vec<String>>,
    chat_id: Option<String>,
) -> Result<String, String> {
    env::load_env();
    let api_key = std::env::var("OPENAI_API_KEY")
        .map_err(|_| "OPENAI_API_KEY not set. Add it to a .env file in the project root.")?;

    let message = message.trim();
    let has_attachments = attachment_paths.as_ref().map_or(false, |p| !p.is_empty());

    // If only attachments (e.g. "summarize this"), use chat.
    if message.is_empty() && has_attachments {
        return openai::chat(
            &api_key,
            "Please summarize or answer based on the attached documents.".to_string(),
            attachment_paths,
        )
        .await;
    }

    // If we have text, classify: task vs chat.
    if !message.is_empty() {
        let classification = openai::classify_task(&api_key, message).await?;
        if classification.is_task {
            let goal = classification
                .goal
                .filter(|g| !g.trim().is_empty())
                .unwrap_or_else(|| message.to_string());
            let goal = goal.trim().to_string();
            if !goal.is_empty() {
                // Desktop task (e.g. "open Chrome"): screenshot + vision loop. URL task: browser agent.
                if is_likely_url_task(&goal) {
                    let summary = agent::agent_submit_goal(goal.clone(), chat_id).await?;
                    let result = agent::agent_run_steps(summary.id, 10)?;
                    let s = &result.summary;
                    let mut reply = format!(
                        "I ran the task ({} steps). Status: {}.\n\n",
                        result.steps_run, s.status
                    );
                    if !s.trace_lines.is_empty() {
                        reply.push_str("Trace:\n");
                        reply.push_str(&s.trace_lines.join("\n"));
                    }
                    if s.status == "blocked" {
                        if let Some(ref desc) = s.pending_action_description {
                            reply.push_str("\n\nWaiting for your approval: ");
                            reply.push_str(desc);
                        }
                    }
                    return Ok(reply);
                } else {
                    return run_desktop_agent(Some(&window), &api_key, &goal).await;
                }
            }
        }
    }

    // Normal chat (with or without attachments).
    openai::chat(
        &api_key,
        message.to_string(),
        attachment_paths,
    )
    .await
}

/// True if the goal is about opening a URL (use browser agent). Else use desktop (screenshot + vision).
fn is_likely_url_task(goal: &str) -> bool {
    let g = goal.to_lowercase();
    g.contains("http://") || g.contains("https://") || g.contains(".com") || g.contains(".org")
        || g.starts_with("open http") || g.starts_with("navigate to http")
}

/// Desktop agent: screenshot every ~1s, send to vision model, execute click/type/scroll until done.
/// Emits "desktop-agent-step" each step so the UI can show thought process live.
async fn run_desktop_agent(
    window: Option<&tauri::Window>,
    api_key: &str,
    goal: &str,
) -> Result<String, String> {
    const MAX_STEPS: u32 = 10;
    let mut trace = Vec::new();
    let mut last_result: Option<String> = None;
    let mut achieved = false;

    for step in 1..=MAX_STEPS {
        // 1. Screenshot
        let image_base64 = agent::harness_desktop::capture_screen()
            .map_err(|e| format!("Screenshot: {}", e))?;

        // 2. Vision: what to do next?
        let action = openai::vision_desktop_action(
            api_key,
            &image_base64,
            goal,
            step,
            last_result.as_deref(),
        )
        .await?;

        let thought = action
            .thought
            .as_deref()
            .or(action.description.as_deref())
            .unwrap_or(&action.action);
        let desc = action.description.as_deref().unwrap_or(&action.action);

        // Trace line: thought process + action
        trace.push(format!(
            "Step {} — Thought: {}\n  Action: {}",
            step, thought, desc
        ));
        if !action.action.eq_ignore_ascii_case("done") {
            match action.action.to_lowercase().as_str() {
                "click" => {
                    let x = action.x.unwrap_or(0);
                    let y = action.y.unwrap_or(0);
                    trace.push(format!("  → click at ({}, {})", x, y));
                }
                "type" => {
                    let t = action.text.as_deref().unwrap_or("");
                    trace.push(format!("  → type \"{}\"", t));
                }
                "scroll" => {
                    let a = action.scroll_amount.unwrap_or(0);
                    trace.push(format!("  → scroll {}", a));
                }
                _ => {}
            }
        }

        if action.action.eq_ignore_ascii_case("done") {
            trace.push("Goal achieved.".to_string());
            achieved = true;
            if let Some(w) = window {
                let _ = w.emit(
                    "desktop-agent-step",
                    serde_json::json!({
                        "step": step,
                        "thought": thought,
                        "action": "done",
                        "description": desc,
                        "done": true,
                    }),
                );
            }
            break;
        }

        // 3. Execute
        let result = match action.action.to_lowercase().as_str() {
            "click" => {
                let x = action.x.unwrap_or(0);
                let y = action.y.unwrap_or(0);
                agent::harness_desktop::move_cursor(x, y)?;
                agent::harness_desktop::cursor_click(Some("left"))?;
                last_result = Some(format!("Clicked at ({}, {})", x, y));
                Ok(())
            }
            "type" => {
                let text = action.text.unwrap_or_default();
                agent::harness_desktop::keyboard_type(&text)?;
                last_result = Some(format!("Typed: {}", text));
                Ok(())
            }
            "scroll" => {
                let amount = action.scroll_amount.unwrap_or(3);
                agent::harness_desktop::cursor_scroll(amount, Some("vertical"))?;
                last_result = Some(format!("Scrolled {}", amount));
                Ok(())
            }
            _ => {
                last_result = Some(format!("Unknown action: {}", action.action));
                Ok(())
            }
        };
        result.map_err(|e: String| e)?;

        // Emit step so UI can show thought process live (after execution, so result is included)
        if let Some(w) = window {
            let _ = w.emit(
                "desktop-agent-step",
                serde_json::json!({
                    "step": step,
                    "thought": thought,
                    "action": action.action,
                    "description": desc,
                    "result": last_result,
                }),
            );
        }

        // 4. ~1 second interval before next screenshot
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }

    if !achieved {
        trace.push(format!(
            "Stopped after {} steps (goal not yet achieved).",
            MAX_STEPS
        ));
    }

    Ok(format!(
        "Desktop task (goal: {}).\n\nAgent thought process:\n\n{}",
        goal,
        trace.join("\n\n")
    ))
}

// --- Desktop cursor and keyboard (expose harness_desktop for frontend / agent) ---

#[derive(serde::Serialize)]
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
}

#[tauri::command]
fn desktop_cursor_position() -> Result<CursorPosition, String> {
    let (x, y) = agent::harness_desktop::cursor_position()?;
    Ok(CursorPosition { x, y })
}

#[tauri::command]
fn desktop_move_cursor(x: i32, y: i32) -> Result<(), String> {
    agent::harness_desktop::move_cursor(x, y)
}

#[tauri::command]
fn desktop_cursor_click(button: Option<String>) -> Result<(), String> {
    agent::harness_desktop::cursor_click(button.as_deref())
}

#[tauri::command]
fn desktop_cursor_scroll(amount: i32, axis: Option<String>) -> Result<(), String> {
    agent::harness_desktop::cursor_scroll(amount, axis.as_deref())
}

#[tauri::command]
fn desktop_keyboard_type(text: String) -> Result<(), String> {
    agent::harness_desktop::keyboard_type(&text)
}

#[tauri::command]
fn desktop_keyboard_key_click(key: String) -> Result<(), String> {
    agent::harness_desktop::keyboard_key_click(&key)
}

#[tauri::command]
fn desktop_keyboard_key_down(key: String) -> Result<(), String> {
    agent::harness_desktop::keyboard_key_down(&key)
}

#[tauri::command]
fn desktop_keyboard_key_up(key: String) -> Result<(), String> {
    agent::harness_desktop::keyboard_key_up(&key)
}

fn main() {
    env::load_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(chat_log::ChatLogState::default())
        .invoke_handler(tauri::generate_handler![
            chatbot_response,
            send_message,
            window::window_minimize,
            window::window_close,
            window::window_toggle_maximize,
            chat_log::append_chat_log,
            chat_log::list_chats,
            chat_log::set_current_chat,
            chat_log::get_current_chat_id,
            chat_log::read_chat_log,
            dialog::open_file_picker,
            dialog::open_folder_picker,
            storage::get_chats_storage_path,
            storage::set_chats_storage_path,
            agent::agent_submit_goal,
            agent::agent_list_sessions,
            agent::agent_get_session,
            agent::agent_run_step,
            agent::agent_run_steps,
            agent::agent_sessions_for_chat,
            agent::agent_approve_action,
            agent::agent_get_session_outcome,
            // Desktop cursor and keyboard (enigo)
            desktop_cursor_position,
            desktop_move_cursor,
            desktop_cursor_click,
            desktop_cursor_scroll,
            desktop_keyboard_type,
            desktop_keyboard_key_click,
            desktop_keyboard_key_down,
            desktop_keyboard_key_up,
        ])
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
