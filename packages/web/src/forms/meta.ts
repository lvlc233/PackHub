export interface FormMeta {
  id: 'a' | 'b' | 'c' | 'd';
  label: string;
  title: string;
  blurb: string;
}

export const FORMS: FormMeta[] = [
  {
    id: 'a',
    label: 'A · 命令行',
    title: '命令行包管理器',
    blurb: '没有网页。search / add / update / remove，像 brew 一样。',
  },
  {
    id: 'b',
    label: 'B · 目录站',
    title: '目录站 + 一行安装',
    blurb: '先看包解决了什么、验证过什么，再复制命令装进项目。',
  },
  {
    id: 'c',
    label: 'C · 桌面启动器',
    title: '桌面启动器',
    blurb: '一个窗口管所有项目实例，图形化装包与切换版本。',
  },
  {
    id: 'd',
    label: 'D · 可视化编辑器',
    title: '可视化整合编辑器',
    blurb: '拖资源、连能力、生成 Pack；面向作者而非使用者。',
  },
];
