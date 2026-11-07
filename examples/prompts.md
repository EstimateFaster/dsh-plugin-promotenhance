# Example rough prompts

These are deliberately underspecified. The panel is expected to ask about the
missing decisions rather than invent them.

## 1. A local CLI tool

```text
/enhance 做一个本地记账小工具，用 JSON 文件存数据，要有命令行和测试
```

Likely questions: runtime, scope (add/list/sum vs. edit/delete), where the code
should live.

## 2. A small web page

```text
/enhance 设计一个周末露营装备清单的移动端页面，要求离线可用、可以打勾和本地保存
```

Likely questions: delivery form (single HTML vs. build), storage, offline
definition, visual direction.

## 3. A refactor

```text
/enhance 把现有脚本里的重复错误处理抽成一个函数，并补上测试
```

Likely questions: which script, acceptable public API changes, test framework.

## What a good result looks like

A finished prompt should contain: goal, current state, concrete work items,
explicit non-goals, acceptance checks, and assumptions. It should not contain
invented requirements or host-absolute paths.
