// 宿主注册入口：import 一遍各宿主模块即完成注册。
//
// 加宿主 = 新建 harness/<id>.ts（里面 registerHarness）+ 这里加一行 import；
// launcher / runtime / 探针都从注册表查，不需要改。

// 注册顺序就是 harnessIds() 的顺序（CLI 帮助按它列出）。
import './dsh.ts';
import './claude-code.ts';
import './codex.ts';

export * from './contract.ts';
