//! Desktop harness: cursor (mouse) position/move/click and keyboard input.
//! Uses enigo for cross-platform simulation (Windows, macOS, Linux).

use enigo::{Keyboard, Mouse};
use serde::Serialize;

/// A desktop window (id and title).
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct DesktopWindow {
    pub id: String,
    pub title: String,
}

/// List visible windows. Stub: returns empty until implemented per-platform.
#[allow(dead_code)]
pub fn list_windows() -> Result<Vec<DesktopWindow>, String> {
    #[cfg(target_os = "windows")]
    {
        list_windows_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = ();
        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn list_windows_windows() -> Result<Vec<DesktopWindow>, String> {
    // TODO: use windows crate EnumWindows + GetWindowText to enumerate.
    Ok(Vec::new())
}

/// Focus a window by id. Stub: no-op until implemented.
#[allow(dead_code)]
pub fn focus_window(_id: &str) -> Result<(), String> {
    Ok(())
}

/// Capture primary screen to PNG, return base64-encoded string.
pub fn capture_screen() -> Result<String, String> {
    use base64::Engine;

    let screens = screenshots::Screen::all().map_err(|e| e.to_string())?;
    let screen = screens
        .first()
        .ok_or_else(|| "No screen found".to_string())?;
    let img = screen.capture().map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    let raw = img.as_raw();
    let mut bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    #[allow(deprecated)]
    encoder
        .encode(raw, w, h, image::ColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// --- Cursor (mouse) and keyboard via enigo ---

fn with_enigo<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut enigo::Enigo) -> Result<T, enigo::InputError>,
{
    let settings = enigo::Settings::default();
    let mut enigo = enigo::Enigo::new(&settings).map_err(|e| e.to_string())?;
    f(&mut enigo).map_err(|e| e.to_string())
}

/// Get current cursor (mouse) position in screen coordinates (x, y).
pub fn cursor_position() -> Result<(i32, i32), String> {
    with_enigo(|e| e.location())
}

/// Move cursor to absolute screen coordinates (x, y).
pub fn move_cursor(x: i32, y: i32) -> Result<(), String> {
    with_enigo(|e| e.move_mouse(x, y, enigo::Coordinate::Abs))
}

/// Mouse button: "left" | "right" | "middle".
fn parse_button(s: &str) -> enigo::Button {
    match s.to_lowercase().as_str() {
        "right" => enigo::Button::Right,
        "middle" => enigo::Button::Middle,
        _ => enigo::Button::Left,
    }
}

/// Click the given mouse button at the current cursor position.
/// button: "left" (default), "right", or "middle".
pub fn cursor_click(button: Option<&str>) -> Result<(), String> {
    let btn = parse_button(button.unwrap_or("left"));
    with_enigo(|e| e.button(btn, enigo::Direction::Click))
}

/// Scroll the mouse wheel. amount: positive = down/right, negative = up/left.
/// axis: "vertical" (default) or "horizontal".
pub fn cursor_scroll(amount: i32, axis: Option<&str>) -> Result<(), String> {
    let a = match axis {
        Some(s) if s.eq_ignore_ascii_case("horizontal") => enigo::Axis::Horizontal,
        _ => enigo::Axis::Vertical,
    };
    with_enigo(|e| e.scroll(amount, a))
}

/// Type a string as if the user typed it (respects keyboard layout).
pub fn keyboard_type(text: &str) -> Result<(), String> {
    with_enigo(|e| e.text(text))
}

/// Parse a key name into enigo::Key. Supports: "enter", "tab", "backspace", "escape",
/// "control", "shift", "alt", "meta", "space", "up", "down", "left", "right",
/// "home", "end", "pageup", "pagedown", "delete", or a single character (e.g. "a", "1").
fn parse_key(name: &str) -> Option<enigo::Key> {
    let k = name.to_lowercase();
    let k = k.trim();
    Some(match k {
        "enter" | "return" => enigo::Key::Return,
        "tab" => enigo::Key::Tab,
        "backspace" => enigo::Key::Backspace,
        "escape" | "esc" => enigo::Key::Escape,
        "control" | "ctrl" => enigo::Key::Control,
        "shift" => enigo::Key::Shift,
        "alt" => enigo::Key::Alt,
        "meta" | "win" | "cmd" => enigo::Key::Meta,
        "space" => enigo::Key::Space,
        "up" => enigo::Key::UpArrow,
        "down" => enigo::Key::DownArrow,
        "left" => enigo::Key::LeftArrow,
        "right" => enigo::Key::RightArrow,
        "home" => enigo::Key::Home,
        "end" => enigo::Key::End,
        "pageup" | "pgup" => enigo::Key::PageUp,
        "pagedown" | "pgdown" => enigo::Key::PageDown,
        "delete" | "del" => enigo::Key::Delete,
        _ if k.len() == 1 => enigo::Key::Unicode(k.chars().next()?),
        _ => return None,
    })
}

/// Press a key (down then up = one key press). key: e.g. "a", "enter", "control".
pub fn keyboard_key_click(key: &str) -> Result<(), String> {
    let k = parse_key(key).ok_or_else(|| format!("Unknown key: {}", key))?;
    with_enigo(|e| {
        e.key(k, enigo::Direction::Press)?;
        e.key(k, enigo::Direction::Release)
    })
}

/// Press key down (hold). Pair with keyboard_key_release.
pub fn keyboard_key_down(key: &str) -> Result<(), String> {
    let k = parse_key(key).ok_or_else(|| format!("Unknown key: {}", key))?;
    with_enigo(|e| e.key(k, enigo::Direction::Press))
}

/// Release key (after keyboard_key_down).
pub fn keyboard_key_up(key: &str) -> Result<(), String> {
    let k = parse_key(key).ok_or_else(|| format!("Unknown key: {}", key))?;
    with_enigo(|e| e.key(k, enigo::Direction::Release))
}
