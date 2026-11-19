// 운영 대화를 사용하지 않는 고정 데이터. 양쪽 비교에서 내용과 순서를 동일하게 유지한다.
export function events(count, text = 'long') {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1, task_id: 'benchmark', kind: i % 3 ? 'assistant' : 'user',
    ts: '2026-01-01T00:00:00.000Z',
    payload: { text: text === 'short' ? `짧은 측정 메시지 ${i + 1}` : `## 측정 메시지 ${i + 1}\n\n` +
      '화면 반응과 데이터 조회 비용을 확인하는 고정 본문입니다. **중요한 내용**과 `코드`를 포함합니다.\n\n'.repeat(8) +
      '| 항목 | 값 |\n| --- | --- |\n| 상태 | 확인 |\n\n```ts\nconst value = 42;\n```' },
  }));
}
