import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Skill } from './types.ts';

// One shared list of desk skills: the compose box completes #<skill> from it and the skill manager
// refreshes it after each change.
let skills: Skill[] = [];
let loading: Promise<void> | null = null;
const listeners = new Set<(s: Skill[]) => void>();

export function refreshSkills() {
  loading = api.skills()
    .then((s) => { skills = s; listeners.forEach((f) => f(s)); })
    .catch(() => { /* hub unreachable: keep the last list */ })
    .finally(() => { loading = null; });
  return loading;
}

export function useSkills(source=''): Skill[] {
  const [list, setList] = useState(skills);
  useEffect(() => {
    if(source){let alive=true;setList([]);void api.skills(source).then(v=>{if(alive)setList(v);},()=>{});return()=>{alive=false;};}
    listeners.add(setList);
    if (!loading) void refreshSkills();
    return () => { listeners.delete(setList); };
  }, [source]);
  return list;
}
