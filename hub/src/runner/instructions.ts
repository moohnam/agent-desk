// What every desk engine session is told on top of its own defaults: Claude gets it appended to the
// system prompt, Codex as developer instructions, agy (no such option) before its first message.

export const DESK_INSTRUCTIONS = [
  // Every utterance becomes a post in the feed, so Korean throughout, not only in final answers.
  '사용자에게 보이는 모든 발화(작업 중간의 짧은 안내 포함)는 한국어로 작성합니다.',
  // The desk opens local links on click (absolute paths, file://, with or without a line suffix).
  '로컬 파일이나 디렉터리를 언급할 때는 경로를 마크다운 링크로 달고, 링크 대상은 절대 경로로 씁니다. 예: [hub/src/hub.ts](/Users/me/proj/hub/src/hub.ts), 특정 줄은 [hub.ts:42](/Users/me/proj/hub/src/hub.ts:42). 경로에 공백이 있으면 링크 대상을 <>로 감쌉니다.',
].join('\n');
