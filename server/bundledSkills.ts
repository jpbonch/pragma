/**
 * Bundled skill definitions that ship with every new workspace database.
 * Sourced from https://github.com/anthropics/skills
 */

export interface BundledSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

// Helper constants for embedding backticks inside template literals
const BT = "`";
const BT3 = "```";

export const BUNDLED_SKILLS: BundledSkill[] = [
  {
    id: "skill_bundled_docx",
    name: "docx",
    description:
      "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads.",
    content: `---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files.

## Quick Reference

| Task | Approach |
|------|----------|
| Read/analyze content | ${BT}pandoc${BT} or unpack for raw XML |
| Create new document | Use ${BT}docx-js${BT} - see Creating New Documents below |
| Edit existing document | Unpack → edit XML → repack - see Editing Existing Documents below |

### Converting .doc to .docx

Legacy ${BT}.doc${BT} files must be converted before editing:

${BT3}bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
${BT3}

### Reading Content

${BT3}bash
# Text extraction with tracked changes
pandoc --track-changes=all document.docx -o output.md

# Raw XML access
python scripts/office/unpack.py document.docx unpacked/
${BT3}

### Converting to Images

${BT3}bash
python scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
${BT3}

## Creating New Documents

Generate .docx files with JavaScript, then validate. Install: ${BT}npm install -g docx${BT}

### Setup
${BT3}javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
        Header, Footer, AlignmentType, PageOrientation, LevelFormat, ExternalHyperlink,
        InternalHyperlink, Bookmark, FootnoteReferenceRun, PositionalTab,
        PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader,
        TabStopType, TabStopPosition, Column, SectionType,
        TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
        VerticalAlign, PageNumber, PageBreak } = require('docx');

const doc = new Document({ sections: [{ children: [/* content */] }] });
Packer.toBuffer(doc).then(buffer => fs.writeFileSync("doc.docx", buffer));
${BT3}

### Validation
After creating the file, validate it. If validation fails, unpack, fix the XML, and repack.
${BT3}bash
python scripts/office/validate.py doc.docx
${BT3}

## Dependencies

- **pandoc**: Text extraction
- **docx**: ${BT}npm install -g docx${BT} (new documents)
- **LibreOffice**: PDF conversion
- **Poppler**: ${BT}pdftoppm${BT} for images`,
  },
  {
    id: "skill_bundled_fdes",
    name: "frontend-design",
    description:
      "Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications. Generates creative, polished code and UI design that avoids generic AI aesthetics.",
    content: `---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Focus on high-impact moments: one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes, predictable layouts, and cookie-cutter design that lacks context-specific character.

Remember: Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.`,
  },
  {
    id: "skill_bundled_pdf0",
    name: "pdf",
    description:
      "Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs.",
    content: `---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools.

## Quick Start

${BT3}python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
${BT3}

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
${BT3}python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
${BT3}

### pdfplumber - Text and Table Extraction

${BT3}python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
${BT3}

### reportlab - Create PDFs

${BT3}python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter
c.drawString(100, height - 100, "Hello World!")
c.save()
${BT3}

## Command-Line Tools

### pdftotext (poppler-utils)
${BT3}bash
pdftotext input.pdf output.txt
pdftotext -layout input.pdf output.txt
${BT3}

### qpdf
${BT3}bash
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
${BT3}

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | ${BT}writer.add_page(page)${BT} |
| Split PDFs | pypdf | One page per file |
| Extract text | pdfplumber | ${BT}page.extract_text()${BT} |
| Extract tables | pdfplumber | ${BT}page.extract_tables()${BT} |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | ${BT}qpdf --empty --pages ...${BT} |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf | See FORMS.md |`,
  },
  {
    id: "skill_bundled_pptx",
    name: "pptx",
    description:
      'Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file; editing, modifying, or updating existing presentations.',
    content: `---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \\"deck,\\" \\"slides,\\" \\"presentation,\\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | ${BT}python -m markitdown presentation.pptx${BT} |
| Edit or create from template | Read editing.md |
| Create from scratch | Read pptxgenjs.md |

## Reading Content

${BT3}bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
${BT3}

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone.

### Before Starting

- **Pick a bold, content-informed color palette**
- **Dominance over equality**: One color should dominate (60-70% visual weight)
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it

### Typography

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

## Dependencies

- ${BT}pip install "markitdown[pptx]"${BT} - text extraction
- ${BT}pip install Pillow${BT} - thumbnail grids
- ${BT}npm install -g pptxgenjs${BT} - creating from scratch
- LibreOffice (${BT}soffice${BT}) - PDF conversion
- Poppler (${BT}pdftoppm${BT}) - PDF to images`,
  },
  {
    id: "skill_bundled_xlsx",
    name: "xlsx",
    description:
      'Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file; create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats.',
    content: `---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
license: Proprietary. LICENSE.txt has complete terms
---

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file.

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.**

### Reading and analyzing data

${BT3}python
import pandas as pd

df = pd.read_excel('file.xlsx')
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)
${BT3}

### Creating new Excel files

${BT3}python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active
sheet['A1'] = 'Hello'
sheet['B2'] = '=SUM(A1:A10)'
sheet['A1'].font = Font(bold=True, color='FF0000')
wb.save('output.xlsx')
${BT3}

### Editing existing Excel files

${BT3}python
from openpyxl import load_workbook

wb = load_workbook('existing.xlsx')
sheet = wb.active
sheet['A1'] = 'New Value'
wb.save('modified.xlsx')
${BT3}

## Recalculating formulas

${BT3}bash
python scripts/recalc.py <excel_file> [timeout_seconds]
${BT3}

## Best Practices

- **pandas**: Best for data analysis, bulk operations, and simple data export
- **openpyxl**: Best for complex formatting, formulas, and Excel-specific features
- Cell indices are 1-based
- Use ${BT}data_only=True${BT} to read calculated values
- Formulas are preserved but not evaluated - use scripts/recalc.py to update values`,
  },
  {
    id: "skill_bundled_dcoa",
    name: "doc-coauthoring",
    description:
      "Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content.",
    content: `---
name: doc-coauthoring
description: Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers.
---

# Doc Co-Authoring Workflow

This skill provides a structured workflow for guiding users through collaborative document creation. Act as an active guide, walking users through three stages: Context Gathering, Refinement & Structure, and Reader Testing.

## Stage 1: Context Gathering

**Goal:** Close the gap between what the user knows and what Claude knows.

### Initial Questions
1. What type of document is this?
2. Who's the primary audience?
3. What's the desired impact when someone reads this?
4. Is there a template or specific format to follow?
5. Any other constraints or context to know?

Then encourage the user to dump all relevant context.

## Stage 2: Refinement & Structure

**Goal:** Build the document section by section through brainstorming, curation, and iterative refinement.

For each section:
1. Ask clarifying questions about what to include
2. Brainstorm 5-20 options
3. User indicates what to keep/remove/combine
4. Draft the section
5. Refine through surgical edits

## Stage 3: Reader Testing

**Goal:** Test the document with a fresh Claude (no context) to verify it works for readers.

1. Predict reader questions
2. Test with sub-agent or fresh conversation
3. Run additional checks for ambiguity and contradictions
4. Fix any gaps found`,
  },
  {
    id: "skill_bundled_jnb0",
    name: "jupyter-notebook",
    description:
      "Use this skill when the user wants to create, edit, read, or work with Jupyter notebooks (.ipynb files). Covers creating notebooks with code cells, markdown cells, and outputs, as well as running and managing notebook workflows.",
    content: `---
name: jupyter-notebook
description: Use this skill when the user wants to create, edit, read, or work with Jupyter notebooks (.ipynb files). Covers creating notebooks with code cells, markdown cells, and outputs, as well as running and managing notebook workflows.
---

# Jupyter Notebook Skill

## Overview

Jupyter notebooks (.ipynb) are JSON documents containing an ordered list of cells (code, markdown, or raw) with optional outputs. They are widely used for data analysis, machine learning, scientific computing, and documentation.

## Reading Notebooks

${BT3}python
import json

with open("notebook.ipynb", "r") as f:
    nb = json.load(f)

for cell in nb["cells"]:
    print(f"Type: {cell['cell_type']}")
    print("".join(cell["source"]))
    print("---")
${BT3}

Or use nbformat:

${BT3}python
import nbformat

nb = nbformat.read("notebook.ipynb", as_version=4)
for cell in nb.cells:
    print(cell.cell_type, ":", "".join(cell.source)[:80])
${BT3}

## Creating Notebooks

${BT3}python
import nbformat

nb = nbformat.v4.new_notebook()
nb.cells = [
    nbformat.v4.new_markdown_cell("# My Notebook\\n\\nThis is an example."),
    nbformat.v4.new_code_cell("import pandas as pd\\nprint('Hello')"),
    nbformat.v4.new_markdown_cell("## Results\\n\\nAnalysis below."),
    nbformat.v4.new_code_cell("df = pd.DataFrame({'x': [1,2,3]})\\ndf"),
]

with open("output.ipynb", "w") as f:
    nbformat.write(nb, f)
${BT3}

## Running Notebooks

${BT3}bash
# Execute notebook and save output in place
jupyter nbconvert --to notebook --execute notebook.ipynb --output notebook.ipynb

# Execute and convert to HTML
jupyter nbconvert --to html --execute notebook.ipynb

# Execute and convert to PDF
jupyter nbconvert --to pdf --execute notebook.ipynb

# Run with papermill (parameterized execution)
papermill input.ipynb output.ipynb -p param_name value
${BT3}

## Editing Notebooks

${BT3}python
import nbformat

nb = nbformat.read("notebook.ipynb", as_version=4)

# Add a cell
nb.cells.append(nbformat.v4.new_code_cell("print('new cell')"))

# Modify a cell
nb.cells[0].source = "# Updated Title"

# Delete a cell
del nb.cells[2]

# Insert at position
nb.cells.insert(1, nbformat.v4.new_markdown_cell("## Inserted Section"))

nbformat.write(nb, open("notebook.ipynb", "w"))
${BT3}

## Converting Formats

${BT3}bash
# To Python script
jupyter nbconvert --to script notebook.ipynb

# To Markdown
jupyter nbconvert --to markdown notebook.ipynb

# To HTML (no execution)
jupyter nbconvert --to html notebook.ipynb

# From Python script to notebook
jupytext --to notebook script.py
${BT3}

## Best Practices

- Use markdown cells to document your analysis flow
- Keep code cells focused on one logical step
- Clear outputs before committing to version control
- Use requirements.txt or environment.yml for dependencies
- Consider using jupytext for version-control-friendly notebook formats

## Dependencies

- **nbformat**: Reading/writing notebooks programmatically
- **jupyter**: Core notebook infrastructure
- **nbconvert**: Converting between formats
- **papermill**: Parameterized notebook execution
- **jupytext**: Notebook/script synchronization`,
  },
];
