import { create } from 'zustand';

type SidebarStoreState = {
  mobileOpen: boolean;
  closeMobile: () => void;
  openMobile: () => void;
  setMobileOpen: (open: boolean) => void;
};

export const useSidebarStore = create<SidebarStoreState>((set) => ({
  closeMobile: () => set({ mobileOpen: false }),
  mobileOpen: false,
  openMobile: () => set({ mobileOpen: true }),
  setMobileOpen: (mobileOpen) => set({ mobileOpen }),
}));
