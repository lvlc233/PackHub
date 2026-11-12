// 一个执行体，两个函数；route 模式按 call 取函数，把后面的 argv 原样传进来。
export function scan(dir) {
  return `scanned ${dir}`;
}

export function run(dir) {
  return `ran ${dir}`;
}

if (process.argv[1]?.endsWith('index.mjs')) {
  console.log(`direct ${process.argv.slice(2).join(' ')}`);
}
