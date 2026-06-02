/**
 * Memory prompt utilities。
 *
 * 含 LLM update prompt 模板、对话格式化、memory→system prompt 格式化、token 估算。
 *
 * Token 计数：
 * - tiktoken 在 Node 端可用 `js-tiktoken`，但属可选依赖。
 * - 这里默认使用启发式 `len/4`，可在外部调用
 *   `setTokenCounter(...)` 注入更精确实现。
 */

export const MEMORY_UPDATE_PROMPT = `You are a memory management system. Your task is to analyze a conversation and update the user's memory profile.

Current Memory State:
<current_memory>
{current_memory}
</current_memory>

New Conversation to Process:
<conversation>
{conversation}
</conversation>

Instructions:
1. Analyze the conversation for important information about the user
2. Extract relevant facts, preferences, and context with specific details (numbers, names, technologies)
3. Update the memory sections as needed following the detailed length guidelines below

Before extracting facts, perform a structured reflection on the conversation:
1. Error/Retry Detection: Did the agent encounter errors, require retries, or produce incorrect results?
   If yes, record the root cause and correct approach as a high-confidence fact with category "correction".
2. User Correction Detection: Did the user correct the agent's direction, understanding, or output?
   If yes, record the correct interpretation or approach as a high-confidence fact with category "correction".
   Include what went wrong in "sourceError" only when category is "correction" and the mistake is explicit in the conversation.
3. Project Constraint Discovery: Were any project-specific constraints discovered during the conversation?
   If yes, record them as facts with the most appropriate category and confidence.

{correction_hint}

Memory Section Guidelines:

**User Context** (Current state - concise summaries):
- workContext: Professional role, company, key projects, main technologies (2-3 sentences)
- personalContext: Languages, communication preferences, key interests (1-2 sentences)
- topOfMind: Multiple ongoing focus areas and priorities (3-5 sentences, detailed paragraph)

**History** (Temporal context - rich paragraphs):
- recentMonths: Detailed summary of recent activities (4-6 sentences or 1-2 paragraphs)
- earlierContext: Important historical patterns (3-5 sentences or 1 paragraph)
- longTermBackground: Persistent background and foundational context (2-4 sentences)

**Facts Extraction**:
- Extract specific, quantifiable details (e.g., "16k+ GitHub stars", "200+ datasets")
- Include proper nouns (company names, project names, technology names)
- Preserve technical terminology and version numbers
- Categories:
  * preference: Tools, styles, approaches user prefers/dislikes
  * knowledge: Specific expertise, technologies mastered, domain knowledge
  * context: Background facts (job title, projects, locations, languages)
  * behavior: Working patterns, communication habits, problem-solving approaches
  * goal: Stated objectives, learning targets, project ambitions
  * correction: Explicit agent mistakes or user corrections, including the correct approach
- Confidence levels:
  * 0.9-1.0: Explicitly stated facts ("I work on X", "My role is Y")
  * 0.7-0.8: Strongly implied from actions/discussions
  * 0.5-0.6: Inferred patterns (use sparingly, only for clear patterns)

**What Goes Where**:
- workContext: Current job, active projects, primary tech stack
- personalContext: Languages, personality, interests outside direct work tasks
- topOfMind: Multiple ongoing priorities and focus areas user cares about recently
- recentMonths: Detailed account of recent technical explorations and work
- earlierContext: Patterns from slightly older interactions still relevant
- longTermBackground: Unchanging foundational facts about the user

**Multilingual Content**:
- Preserve original language for proper nouns and company names
- Keep technical terms in their original form (DeepSeek, LangGraph, etc.)
- Note language capabilities in personalContext

Output Format (JSON):
{
  "user": {
    "workContext": { "summary": "...", "shouldUpdate": true/false },
    "personalContext": { "summary": "...", "shouldUpdate": true/false },
    "topOfMind": { "summary": "...", "shouldUpdate": true/false }
  },
  "history": {
    "recentMonths": { "summary": "...", "shouldUpdate": true/false },
    "earlierContext": { "summary": "...", "shouldUpdate": true/false },
    "longTermBackground": { "summary": "...", "shouldUpdate": true/false }
  },
  "newFacts": [
    { "content": "...", "category": "preference|knowledge|context|behavior|goal|correction", "confidence": 0.0-1.0 }
  ],
  "factsToRemove": ["fact_id_1", "fact_id_2"]
}

Important Rules:
- Only set shouldUpdate=true if there's meaningful new information
- Follow length guidelines: workContext/personalContext are concise (1-3 sentences), topOfMind and history sections are detailed (paragraphs)
- Include specific metrics, version numbers, and proper nouns in facts
- Only add facts that are clearly stated (0.9+) or strongly implied (0.7+)
- Use category "correction" for explicit agent mistakes or user corrections; assign confidence >= 0.95 when the correction is explicit
- Include "sourceError" only for explicit correction facts when the prior mistake or wrong approach is clearly stated; omit it otherwise
- Remove facts that are contradicted by new information
- When updating topOfMind, integrate new focus areas while removing completed/abandoned ones
  Keep 3-5 concurrent focus themes that are still active and relevant
- For history sections, integrate new information chronologically into appropriate time period
- Preserve technical accuracy - keep exact names of technologies, companies, projects
- Focus on information useful for future interactions and personalization
- IMPORTANT: Do NOT record file upload events in memory. Uploaded files are
  session-specific and ephemeral — they will not be accessible in future sessions.
  Recording upload events causes confusion in subsequent conversations.

Return ONLY valid JSON, no explanation or markdown.`;

import type { MemoryData, Fact } from './types';

// Token counting

export type TokenCounter = (text: string) => number;

let _tokenCounter: TokenCounter = (text) => Math.floor(text.length / 4);

/** 注入更精确的 token 计数实现（如 js-tiktoken）。默认按字符 / 4 估算。 */
export function setTokenCounter(counter: TokenCounter | null): void {
  _tokenCounter = counter ?? ((text) => Math.floor(text.length / 4));
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return _tokenCounter(text);
  } catch {
    return Math.floor(text.length / 4);
  }
}

// 强制 confidence 在 0-1 之间
function coerceConfidence(value: any, dft = 0.0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.min(1, dft));
  return Math.max(0, Math.min(1, n));
}

// formatMemoryForInjection

export function formatMemoryForInjection(
  memoryData: MemoryData | null | undefined,
  maxTokens = 2000,
): string {
  if (!memoryData) return '';

  const sections: string[] = [];

  // User context
  const user = memoryData.user;
  if (user) {
    const lines: string[] = [];
    if (user.workContext?.summary) lines.push(`Work: ${user.workContext.summary}`);
    if (user.personalContext?.summary) lines.push(`Personal: ${user.personalContext.summary}`);
    if (user.topOfMind?.summary) lines.push(`Current Focus: ${user.topOfMind.summary}`);
    if (lines.length > 0) {
      sections.push('User Context:\n' + lines.map((s) => `- ${s}`).join('\n'));
    }
  }

  // History
  const history = memoryData.history;
  if (history) {
    const lines: string[] = [];
    if (history.recentMonths?.summary) lines.push(`Recent: ${history.recentMonths.summary}`);
    if (history.earlierContext?.summary) lines.push(`Earlier: ${history.earlierContext.summary}`);
    if (history.longTermBackground?.summary)
      lines.push(`Background: ${history.longTermBackground.summary}`);
    if (lines.length > 0) {
      sections.push('History:\n' + lines.map((s) => `- ${s}`).join('\n'));
    }
  }

  // Facts
  const facts = Array.isArray(memoryData.facts) ? memoryData.facts : [];
  if (facts.length > 0) {
    const ranked = facts
      .filter(
        (f): f is Fact =>
          !!f &&
          typeof f === 'object' &&
          typeof f.content === 'string' &&
          f.content.trim().length > 0,
      )
      .slice()
      .sort((a, b) => coerceConfidence(b.confidence, 0) - coerceConfidence(a.confidence, 0));

    const baseText = sections.join('\n\n');
    const baseTokens = baseText ? countTokens(baseText) : 0;
    const factsHeader = 'Facts:\n';
    const separatorTokens = baseText ? countTokens('\n\n' + factsHeader) : countTokens(factsHeader);
    let runningTokens = baseTokens + separatorTokens;

    const factLines: string[] = [];
    for (const fact of ranked) {
      const content = (typeof fact.content === 'string' ? fact.content : '').trim();
      if (!content) continue;
      const category = (typeof fact.category === 'string' && fact.category.trim()) || 'context';
      const confidence = coerceConfidence(fact.confidence, 0);
      const sourceError = typeof fact.sourceError === 'string' ? fact.sourceError.trim() : '';
      const line =
        category === 'correction' && sourceError
          ? `- [${category} | ${confidence.toFixed(2)}] ${content} (avoid: ${sourceError})`
          : `- [${category} | ${confidence.toFixed(2)}] ${content}`;

      const lineText = factLines.length > 0 ? '\n' + line : line;
      const lineTokens = countTokens(lineText);
      if (runningTokens + lineTokens <= maxTokens) {
        factLines.push(line);
        runningTokens += lineTokens;
      } else {
        break;
      }
    }

    if (factLines.length > 0) {
      sections.push('Facts:\n' + factLines.join('\n'));
    }
  }

  if (sections.length === 0) return '';

  let result = sections.join('\n\n');
  const tokenCount = countTokens(result);
  if (tokenCount > maxTokens) {
    const charPerToken = result.length / Math.max(1, tokenCount);
    const targetChars = Math.floor(maxTokens * charPerToken * 0.95);
    result = result.slice(0, Math.max(0, targetChars)) + '\n...';
  }
  return result;
}

// formatConversationForUpdate

import { extractMessageContentText } from '@/utils/common';

const UPLOAD_BLOCK_RE = /<uploaded_files>[\s\S]*?<\/uploaded_files>\n*/gi;

function getMessageRole(message: { _getType?: () => string; type?: unknown }): string {
  if (typeof message?._getType === 'function') return message._getType();
  return typeof message?.type === 'string' ? message.type : 'unknown';
}

export function formatConversationForUpdate(messages: unknown[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const messageObj = message as { _getType?: () => string; type?: unknown; content?: unknown };
    const role = getMessageRole(messageObj);
    let content = extractMessageContentText(messageObj?.content);

    if (role === 'human') {
      content = content.replace(UPLOAD_BLOCK_RE, '').trim();
      if (!content) continue;
    }

    if (content.length > 1000) content = content.slice(0, 1000) + '...';

    if (role === 'human') lines.push(`User: ${content}`);
    else if (role === 'ai') lines.push(`Assistant: ${content}`);
  }
  return lines.join('\n\n');
}
