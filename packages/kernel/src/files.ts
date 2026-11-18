// files.ts	仓库里反复出现的文件名与状态目录：改名字只改这里

/** Pack 清单文件名。 */
export const MANIFEST_FILE = 'packhub.yaml';

/** 锁文件名。 */
export const LOCK_FILE = 'packhub.lock.json';

/** 项目内的安装状态目录（相对项目根）。 */
export const STATE_DIR = '.packhub';

/** 安装状态文件；路径只在这里由 STATE_DIR 拼一次，调用方直接 join(root, STATE_FILE)。 */
export const STATE_FILE = `${STATE_DIR}/state.json`;
