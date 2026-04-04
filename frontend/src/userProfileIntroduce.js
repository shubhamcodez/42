/** Default profile shape (must match `backend/memory/user_profile_io.py`). */
export const EMPTY_USER_PROFILE = {
  identity: { name: null, pronouns: null, languages: null },
  demographics: { age_range: null, gender: null, timezone: null },
  personality: {
    communication: null,
    learning_style: null,
    risk_tolerance: null,
  },
  preferences: {
    tools_stack: null,
    editor_environment: null,
    code_style: null,
    docs_comments: null,
  },
  goals: { current_projects: null, standing_goals: null },
  boundaries: { topics_avoid: null, accessibility_needs: null },
  appendix_notes: [],
}

/** Wizard steps: `key` is nested path except `appendix` steps. */
export const INTRODUCE_STEPS = [
  {
    key: ['identity', 'name'],
    prompt:
      '**How should I address you?**\n\nYour name or what you like to be called. Say **skip** to leave blank.',
  },
  {
    key: ['identity', 'pronouns'],
    prompt: '**Pronouns** (optional)\n\ne.g. they/them, she/her, he/him — or **skip**.',
  },
  {
    key: ['identity', 'languages'],
    prompt:
      '**Languages**\n\nWhich languages do you use with me (natural or programming)? **skip** if N/A.',
  },
  {
    key: ['demographics', 'age_range'],
    prompt:
      '**Age or age range** *(only if you are comfortable sharing)*\n\n**skip** if you prefer not to say.',
  },
  {
    key: ['demographics', 'gender'],
    prompt: '**Gender** *(optional)*\n\n**skip** if you prefer not to say.',
  },
  {
    key: ['demographics', 'timezone'],
    prompt:
      '**Timezone or region**\n\ne.g. `Europe/Berlin`, “US East Coast” — helps with scheduling context.',
  },
  {
    key: ['personality', 'communication'],
    prompt:
      '**Communication style**\n\nDo you prefer short answers, deep dives, formal, casual?',
  },
  {
    key: ['personality', 'learning_style'],
    prompt:
      '**How you like explanations**\n\ne.g. step-by-step, analogies, diagrams described in text.',
  },
  {
    key: ['personality', 'risk_tolerance'],
    prompt:
      '**Risk / boldness**\n\nPrefer safe defaults, or okay with experimental commands and refactors?',
  },
  {
    key: ['preferences', 'tools_stack'],
    prompt: '**Tools and stack**\n\nFrameworks, languages, or platforms you use most.',
  },
  {
    key: ['preferences', 'editor_environment'],
    prompt: '**Editor / environment**\n\ne.g. VS Code, Cursor, terminal preferences.',
  },
  {
    key: ['preferences', 'code_style'],
    prompt: '**Code style**\n\nTabs vs spaces, formatting, patterns you care about.',
  },
  {
    key: ['preferences', 'docs_comments'],
    prompt: '**Documentation**\n\nHow much commenting and docs do you want in generated code?',
  },
  {
    key: ['goals', 'current_projects'],
    prompt: '**Current projects or domains**\n\nWhat are you building or learning right now?',
  },
  {
    key: ['goals', 'standing_goals'],
    prompt: '**Standing goals**\n\nLonger-term things I should optimize for when helping you.',
  },
  {
    key: ['boundaries', 'topics_avoid'],
    prompt: '**Topics to avoid or handle gently**\n\nSubjects or tones you do not want.',
  },
  {
    key: ['boundaries', 'accessibility_needs'],
    prompt: '**Accessibility or other needs**\n\nAnything that changes how I should format or explain.',
  },
  {
    appendix: true,
    prompt:
      '**Anything else?**\n\nOne free-form note for your profile (tip, context, boundary). **skip** if nothing.',
  },
]

export const INTRODUCE_STEP_COUNT = INTRODUCE_STEPS.length

const SKIP_RE = /^(skip|n\/a|n_a|na|none|no|—|-|–|\.)$/i

export function normalizeProfileAnswer(text) {
  const t = (text ?? '').trim()
  if (!t || SKIP_RE.test(t)) return null
  return t
}

export function setUserProfileField(obj, path, value) {
  if (!path?.length) return
  let o = obj
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    if (!o[k] || typeof o[k] !== 'object') o[k] = {}
    o = o[k]
  }
  o[path[path.length - 1]] = value
}

export function formatIntroduceWelcome(total) {
  return `# Introduce yourself\n\nAnswer each prompt in chat. There are **${total}** steps. Say **skip** anytime to leave a field empty.\n\n---\n\n`
}

export function formatIntroduceQuestion(stepIndex, total) {
  const step = INTRODUCE_STEPS[stepIndex]
  if (!step) return ''
  return `${step.prompt}\n\n*(Question ${stepIndex + 1} of ${total})*`
}
