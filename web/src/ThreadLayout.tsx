import type { ComponentPropsWithRef, CSSProperties, ReactNode } from 'react';

type FrameProps = ComponentPropsWithRef<'section'> & {
  width?: number;
  focused: boolean;
  accent?: string;
};

export function ThreadFrame({ className, width, focused, accent, ...props }: FrameProps) {
  const style = {
    ...(width !== undefined && { '--w': `${width}px` }),
    ...(accent && { '--pc': accent }),
    ...props.style,
  } as CSSProperties;
  return <section {...props} className={`column thread-surface ${className ?? ''}${focused ? ' focused' : ''}`} style={style} />;
}

export function ThreadHeader({ children, meta, notice }: { children: ReactNode; meta?: ReactNode; notice?: ReactNode }) {
  return <header className="thread-head">
    <div className="row1">{children}</div>
    {notice}
    {meta && <div className="meta">{meta}</div>}
  </header>;
}

export function ThreadFeed({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div {...props} className={`feed thread-feed${className ? ' ' + className : ''}`} />;
}
