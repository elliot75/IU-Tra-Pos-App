"""Cache TOC page references from a rendered PDF, retaining Word's live fields.

Run after build_system_spec.cjs and LibreOffice PDF export, then re-export and
check that chapter pagination is unchanged. Requires PyMuPDF for PDF reading.
Usage: python -I scripts/finalize_system_spec.py specification.docx render.pdf
"""
import json
import re
import sys
import zipfile
from pathlib import Path

import pymupdf

word_path, pdf_path = map(Path, sys.argv[1:3])
with pymupdf.open(pdf_path) as pdf:
    chapters = [(title, page) for level, title, page in pdf.get_toc() if level == 1]
if len(chapters) != 12:
    raise ValueError(f"Expected 12 chapter bookmarks; found {len(chapters)}")
with zipfile.ZipFile(word_path) as archive:
    files = [(info, archive.read(info.filename)) for info in archive.infolist()]
xml = next(data for info, data in files if info.filename == "word/document.xml").decode("utf-8")
for index, (title, page) in enumerate(chapters, 1):
    pattern = re.compile(
        r'(<w:instrText[^>]*>PAGEREF _Toc' + str(index)
        + r' \\h</w:instrText><w:fldChar w:fldCharType="separate"/>)'
        + r'(?:<w:t(?: [^>]*)?>\d+</w:t>)?'
        + r'(<w:fldChar w:fldCharType="end"/>)'
    )
    xml, count = pattern.subn(lambda match: match[1] + f"<w:t>{page}</w:t>" + match[2], xml)
    if count != 1:
        raise ValueError(f"Expected one page-reference field for {title}; found {count}")
# Preserve XML formatting, all non-document parts, and ZIP metadata.
# The original development plan is never touched.
temporary = word_path.with_suffix(".finalizing.docx")
with zipfile.ZipFile(temporary, "w") as archive:
    for info, data in files:
        archive.writestr(info, xml.encode("utf-8") if info.filename == "word/document.xml" else data)
temporary.replace(word_path)
print(json.dumps({"toc_pages": chapters}, ensure_ascii=False, indent=2))
