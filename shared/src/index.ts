/**
 * @srszq/shared — SRSZQ.com 共享纯逻辑（唯一规则来源）。
 * 引擎（game）与 AI（ai）零框架依赖；禁止引入 UI / IO。
 * 消费方（frontend/backend/scripts）通过本包公共导出或
 * '@srszq/shared/game|ai/*' 子路径引用。
 */
export * from './game/types';
export * from './game/eligibility';
export * from './game/legalMoves';
export * from './game/winDetection';
export * from './game/rules';
export * from './ai/types';
export * from './ai/seats';
export * from './ai/rng';
export * from './ai/tacticMixer';
export * from './ai/evaluation';
export * from './ai/chooseAIMove';
export * from './ai/search';
export * from './ai/searchAgents';
export * from './ai/threatAnalysis';
export * from './ai/moveOrdering';
export * from './ai/config/defaultWeights';
export { randomAgent } from './ai/randomAgent';
export { tacticalAgent } from './ai/tacticalAgent';
export { selfishAgent } from './ai/selfishAgent';
