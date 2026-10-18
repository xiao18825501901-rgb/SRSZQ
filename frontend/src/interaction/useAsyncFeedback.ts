import { useCallback, useEffect, useRef, useState } from 'react';
export type AsyncOutcome<T>={ok:true;value:T}|{ok:false;error:unknown}|{ok:false;skipped:true}|{ok:false;rejected:true;value:T};
/** UI lifecycle only. No retry, fake success, timer reset or replacement for server idempotency.
 * Concurrent clicks return skipped; caller must not advance its puzzle/route for skipped/error.
 * For domain APIs pass isAccepted (e.g. serverResult.correct === true); HTTP 200 alone is not puzzle success.
 * Changing scope invalidates feedback from a former game/puzzle; it does NOT undo an HTTP write. */
export function useAsyncFeedback(scope:string){
  const current=useRef(scope);current.current=scope;
  const mounted=useRef(true), busy=useRef(false), generation=useRef(0);
  const [state,setState]=useState<{pending:boolean;feedback:'idle'|'success'|'error';error:unknown}>({pending:false,feedback:'idle',error:null});
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;busy.current=false;};},[]);
  const reset=useCallback(()=>{generation.current++;busy.current=false;setState({pending:false,feedback:'idle',error:null});},[]);
  useEffect(()=>{reset();},[scope,reset]);
  const run=useCallback(async<T,>(task:()=>Promise<T>,isAccepted?:(value:T)=>boolean):Promise<AsyncOutcome<T>>=>{
    if(busy.current)return {ok:false,skipped:true};
    busy.current=true;const g=generation.current,s=current.current;
    setState({pending:true,feedback:'idle',error:null});
    try{
      const value=await task();
      if(!mounted.current||g!==generation.current||s!==current.current)return {ok:false,skipped:true};
      if(isAccepted&&!isAccepted(value)){
        setState({pending:false,feedback:'error',error:null});return {ok:false,rejected:true,value};
      }
      setState({pending:false,feedback:'success',error:null});return {ok:true,value};
    }catch(error){
      if(!mounted.current||g!==generation.current||s!==current.current)return {ok:false,skipped:true};
      setState({pending:false,feedback:'error',error});return {ok:false,error};
    }finally{if(g===generation.current)busy.current=false;}
  },[]);
  return {...state,run,reset};
}
