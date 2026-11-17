/** Run all layout reads before React/DOM writes; callers can cancel work after unmount. */
export function createLayoutBatch(schedule: (run: () => void) => number, cancel: (id: number) => void) {
  const jobs = new Set<{ active: boolean; read: () => () => void }>();
  let frame: number | undefined;
  return (read: () => () => void) => {
    const job = { active: true, read };
    jobs.add(job);
    frame ??= schedule(() => {
      frame = undefined;
      const pending = [...jobs]; jobs.clear();
      const writes = pending.map(item => ({ item, write: item.active ? item.read() : undefined }));
      for (const { item, write } of writes) if (item.active) write?.();
    });
    return () => {
      job.active = false; jobs.delete(job);
      if (!jobs.size && frame !== undefined) { cancel(frame); frame = undefined; }
    };
  };
}
export const scheduleLayoutRead = createLayoutBatch(fn => requestAnimationFrame(fn), id => cancelAnimationFrame(id));
