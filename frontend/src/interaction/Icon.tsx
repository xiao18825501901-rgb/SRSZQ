import type { CSSProperties } from 'react';

/** Original compact stroke icons. No icon font, remote asset, or brand artwork. */
const paths = {
  plus: ['M12 5v14', 'M5 12h14'],
  arrowRight: ['M5 12h14', 'm13 6 6 6-6 6'],
  arrowLeft: ['M19 12H5', 'm11 6-6 6 6 6'],
  chevronLeft: ['m15 5-7 7 7 7'],
  chevronRight: ['m9 5 7 7-7 7'],
  first: ['M5 5v14', 'm17 5-7 7 7 7'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  check: ['m5 12 4 4L19 6'],
  undo: ['M9 5 4 10l5 5', 'M4 10h10a6 6 0 0 1 0 12'],
  replay: ['M4 5v6h6', 'M4.6 11a8 8 0 1 1 1 7'],
  history: ['M4 4v6h6', 'M4.3 10a8 8 0 1 1 1.2 7.5', 'M12 7v5l3 2'],
  settings: ['M4 7h16', 'M4 17h16', 'M8 4v6', 'M16 14v6'],
  help: ['M9.1 8a3 3 0 0 1 5.8 1c0 2-3 2-3 4', 'M12 17h.01', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
  exit: ['M9 4H5v16h4', 'M9 12h12', 'm17 8 4 4-4 4'],
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  share: ['M12 15V3', 'm7 8 5-5 5 5', 'M5 12v8h14v-8'],
  warning: ['m12 3 10 18H2L12 3Z', 'M12 9v5', 'M12 17h.01'],
  target: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0', 'M12 11v2'],
  shield: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z'],
  book: ['M3 5h7l2 2 2-2h7v15h-7l-2 1-2-1H3V5Z', 'M12 7v14'],
  spark: ['m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z'],
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 19, className = '', style }: {name:IconName;size?:number;className?:string;style?:CSSProperties}) {
  return <svg className={`sq-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}>
    {paths[name].map((d,i)=><path d={d} key={i}/>)}
  </svg>;
}
