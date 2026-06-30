import * as React from 'react';

import { cn } from './cn';

export function Sidebar({ className, ...props }: React.ComponentProps<'aside'>) {
  return (
    <aside
      className={cn(
        'hidden h-[100dvh] min-h-[100svh] w-[280px] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar pb-0 pt-5 md:flex',
        className,
      )}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 items-center gap-3 px-3', className)} {...props} />;
}

export function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden', className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<'nav'>) {
  return <nav className={cn('flex flex-col gap-1', className)} {...props} />;
}
