import type { ReactNode } from "react";

const Svg = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
export const IconMenu = () => <Svg><path d="M4 6h16M4 12h16M4 18h16" /></Svg>;
export const IconClose = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IconZoom = () => <Svg><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" /></Svg>;
export const IconTable = () => <Svg><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 10h18M3 15h18M9 4v16" /></Svg>;
export const IconPan = () => <Svg size={18}><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" /></Svg>;
export const IconInfo = () => <Svg size={18}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></Svg>;
export const IconPin = () => <Svg size={18}><path d="M12 21s-6-5.2-6-10a6 6 0 1112 0c0 4.8-6 10-6 10z" /><circle cx="12" cy="11" r="2" /></Svg>;
export const IconRuler = () => <Svg size={18}><path d="M3 17L17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></Svg>;
export const IconArea = () => <Svg size={18}><path d="M5 8l9-4 5 7-4 8-10-2z" /></Svg>;
export const IconCube = () => <Svg size={18}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></Svg>;
export const IconPrint = () => <Svg size={18}><path d="M7 9V3h10v6M7 17H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2" /><rect x="7" y="14" width="10" height="7" /></Svg>;
export const IconEdit = () => <Svg><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Svg>;
export const IconChart = () => <Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>;
export const IconLink = () => <Svg><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0010 18.7l1-1" /></Svg>;
export const IconSeries = () => <Svg size={18}><path d="M3 20h18M3 20V4" /><path d="M6 15l4-5 3 3 5-7" /><circle cx="18" cy="6" r="1.2" /></Svg>;
export const IconCompare = () => <Svg size={18}><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16M8 10l-2 2 2 2M16 10l2 2-2 2" /></Svg>;
export const IconSearch = () => <Svg><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></Svg>;
export const IconBookmark = () => <Svg size={18}><path d="M6 3h12v18l-6-4-6 4z" /></Svg>;
export const IconDoc = () => <Svg><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></Svg>;
