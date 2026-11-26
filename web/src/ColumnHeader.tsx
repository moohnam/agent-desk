import type { ReactNode } from 'react';

/** Shared frame for the feed and its companion columns. */
export function ColumnHeader({children, footer}: {children:ReactNode; footer?:ReactNode}) {
  return <header className={`col-head${footer ? ' has-workdir' : ''}`}><div className="col-head-row">{children}</div>{footer}</header>;
}
