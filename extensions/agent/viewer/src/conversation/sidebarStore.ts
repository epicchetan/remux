import { create } from 'zustand';

type SidebarStore = {
  mobileOpen: boolean;
  closeMobile: () => void;
  openMobile: () => void;
  setMobileOpen: (open: boolean) => void;
};

export const useAgentSidebarStore = create<SidebarStore>((set) => ({
  closeMobile: () => set({ mobileOpen: false }),
  mobileOpen: false,
  openMobile: () => set({ mobileOpen: true }),
  setMobileOpen: (mobileOpen) => set({ mobileOpen }),
}));
