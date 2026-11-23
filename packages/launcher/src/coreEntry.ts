/**
 * core 内部入口的隐藏动词：coreClient 按需拉起、登录计划任务都从 bin.ts 走它。
 * 单列一个模块只放常量，避免 coreMain ↔ coreClient 互相 import 成环。
 * 它不是命令：不进 main.subCommands，也不进 --help。
 */
export const CORE_ENTRY = '__core';
