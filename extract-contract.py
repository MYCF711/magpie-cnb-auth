r"""从 magpie 二进制提取内嵌的插件契约源码。

magpie 是 Go 编译的单文件二进制，插件契约源码被嵌进去当文档。
共 21 章、约 200 KB，比 usemagpie.ai/docs/plugins 更全
（官方文档漏了 auth.checkin）。

用法：
    python extract-contract.py [magpie 可执行文件路径]

默认路径：E:/Downloads/magpie-windows-amd64.exe
"""
import re
import sys
from pathlib import Path

# 章节标题的形状："// ---- <name> ----...----"
SECTION_RE = re.compile(rb"// ---- [a-zA-Z][a-zA-Z0-9 ,'\-]{3,60}-{3,}")


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else r"E:/Downloads/magpie-windows-amd64.exe"
    data = Path(exe).read_bytes()
    print(f"read {exe} ({len(data):,} bytes)")

    # 找所有章节标题的位置
    marks = [(m.start(), m.group().decode("ascii", "ignore").strip())
             for m in SECTION_RE.finditer(data)]

    # 过滤：只保留连续的、位置合理的（去掉噪声）
    if not marks:
        print("no sections found")
        return 1

    print(f"found {len(marks)} section titles")

    out = []
    for i, (pos, title) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else pos + 30000
        # 单章最多 30 KB，防止串到二进制垃圾
        end = min(end, pos + 30000)
        chunk = data[pos:end]
        s = re.sub(rb"[^\x20-\x7e\n]", b" ", chunk).decode("ascii", "ignore")
        s = re.sub(r"[ \t]+", " ", s)
        s = re.sub(r"\n{3,}", "\n\n", s)
        out.append(s)
        print(f"  {pos:>10}  {title}")

    text = "\n\n".join(out)
    dst = Path(__file__).with_name("magpie-plugin-contract-full.txt")
    dst.write_text(text, encoding="utf-8")
    print(f"\nwrote {len(text):,} chars, {len(out)} sections -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
