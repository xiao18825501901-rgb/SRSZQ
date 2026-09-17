import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameState, Player } from '../../../shared/src/game/types';
import { currentPlayerOf, getWinningPoints, isLegalMove } from '../../../shared/src/game/legalMoves';
import { colorName } from '../playerPresentation';

interface Props {
  state: GameState; showLegal: boolean; showWinning: boolean;
  onCellClick: (row: number, col: number) => void;
  showNumbers?: boolean; disabled?: boolean; decorative?: boolean;
}
/** N × N intersections, never N × N square cells. Shared engine coordinates are unchanged. */
export function Board({ state, showLegal, showWinning, onCellClick, showNumbers=false, disabled=false, decorative=false }: Props) {
  const n=state.boardSize, current=currentPlayerOf(state);
  const [hover,setHover]=useState<string|null>(null);
  const winSet=new Set(state.winLine?.map(p=>`${p.row},${p.col}`));
  const numbers=useMemo(()=>{
    const map=new Map<string,number>(); let no=0;
    for(const m of state.moves) if(!m.pass && m.row!==undefined && m.col!==undefined) map.set(`${m.row},${m.col}`,++no);
    return map;
  },[state.moves]);
  const last=[...state.moves].reverse().find(m=>!m.pass);
  const wins=useMemo(()=>{
    const map=new Map<string,Player[]>();
    if(showWinning) for(const p of ['A','B','C'] as Player[]) for(const pos of getWinningPoints(state.board,p)) {
      const k=`${pos.row},${pos.col}`;map.set(k,[...(map.get(k)??[]),p]);
    }
    return map;
  },[state.board,showWinning]);
  const star=[3,Math.floor(n/2),n-4];
  return <div className={`board-wrap go-board-wrap ${decorative?'decorative-board':''}`}>
    <div className="go-board" data-testid="board" data-board-size={n} style={{'--board-n':n} as CSSProperties} role="group" aria-label={`${n}路交叉点棋盘`}>
      <div className="go-coordinates top">{Array.from({length:n},(_,i)=><span key={i} style={{left:`${i/(n-1)*100}%`}}>{i+1}</span>)}</div>
      <div className="go-coordinates left">{Array.from({length:n},(_,i)=><span key={i} style={{top:`${i/(n-1)*100}%`}}>{i+1}</span>)}</div>
      <div className="go-grid">
        <svg className="go-lines" viewBox="0 0 1000 1000" aria-hidden="true">
          {Array.from({length:n},(_,i)=><g key={i}><line x1={i*1000/(n-1)} y1="0" x2={i*1000/(n-1)} y2="1000"/><line x1="0" y1={i*1000/(n-1)} x2="1000" y2={i*1000/(n-1)}/></g>)}
          {star.flatMap(r=>star.map(c=><circle key={`${r},${c}`} cx={c*1000/(n-1)} cy={r*1000/(n-1)} r="4.6"/>))}
        </svg>
        {state.board.flatMap((line,row)=>line.map((piece,col)=>{
          const k=`${row},${col}`, empty=piece===null;
          const legal=empty && state.status==='playing' && isLegalMove(state,row,col);
          const forbidden=empty && state.status==='playing' && !legal;
          const isLast=last?.row===row && last?.col===col;
          const style={left:`${col/(n-1)*100}%`,top:`${row/(n-1)*100}%`,width:`${92/(n-1)}%`,height:`${92/(n-1)}%`} as CSSProperties;
          const label=`第${row+1}行第${col+1}路，${piece?`${colorName(piece)}棋${showNumbers?'，第'+numbers.get(k)+'手':''}`:forbidden?'禁手':legal?'可落子':'空位'}`;
          return <button key={k} type="button" className={`go-point ${piece?'occupied':''} ${forbidden?'forbidden':''} ${winSet.has(k)?'winning-point':''}`}
            style={style} data-row={row} data-col={col} data-piece={piece??''} aria-label={label} aria-disabled={disabled||!legal}
            tabIndex={decorative?-1:0} onPointerEnter={()=>setHover(k)} onPointerLeave={()=>setHover(null)}
            onClick={()=>{if(!disabled&&legal)onCellClick(row,col)}}>
            {piece ? <span className={`go-stone stone-${piece} ${isLast?'last-stone':''} ${winSet.has(k)?'winning-stone':''}`}>{showNumbers?numbers.get(k):isLast&&!decorative?<i className="last-dot"/>:null}</span> : <>
              {showLegal&&legal&&!decorative&&<span className="go-legal-dot"/>}
              {showLegal&&forbidden&&<span className="go-forbidden">×</span>}
              {showWinning&&(wins.get(k)??[]).map((p,i)=><span key={p} className={`go-winning-ring ring-${p}`} style={{inset:`${8+i*9}%`}}/>)}
              {!disabled&&legal&&hover===k&&<span className={`go-stone stone-${current} preview-stone`}/>}
            </>}
          </button>;
        }))}
      </div>
    </div>
  </div>;
}
