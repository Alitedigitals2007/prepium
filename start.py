from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.dml.color import RGBColor
from pptx.oxml.xmlchemy import OxmlElement

# =========================
# CONFIG
# =========================
OUTPUT_FILE = "Prepium_School_Pitch_Deck.pptx"
WEBSITE = "theprepium.vercel.app"
ADDRESS_LINE = "Same address as your previous version"  # replace if needed

FONT = "Calibri"

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)

# Brand palette
NAVY = RGBColor(15, 23, 42)
BLUE = RGBColor(37, 99, 235)
CYAN = RGBColor(6, 182, 212)
GREEN = RGBColor(34, 197, 94)
ORANGE = RGBColor(249, 115, 22)
PURPLE = RGBColor(139, 92, 246)
RED = RGBColor(239, 68, 68)

BG = RGBColor(247, 249, 252)
CARD = RGBColor(255, 255, 255)
TEXT = RGBColor(17, 24, 39)
MUTED = RGBColor(100, 116, 139)
LIGHT = RGBColor(226, 232, 240)
VERY_LIGHT = RGBColor(241, 245, 249)
WHITE = RGBColor(255, 255, 255)

# =========================
# HELPERS
# =========================
def set_bg(slide, color):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color

def format_paragraph(p, size=14, color=TEXT, bold=False, align=PP_ALIGN.LEFT):
    p.alignment = align
    p.space_before = Pt(0)
    p.space_after = Pt(2)
    for r in p.runs:
        r.font.name = FONT
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = color

def add_textbox(slide, left, top, width, height, text,
                font_size=14, color=TEXT, bold=False,
                align=PP_ALIGN.LEFT, valign=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(left, top, width, height)
    tf = tb.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.vertical_anchor = valign
    tf.margin_left = Inches(0.03)
    tf.margin_right = Inches(0.03)
    tf.margin_top = Inches(0.02)
    tf.margin_bottom = Inches(0.02)

    lines = text.split("\n")
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        format_paragraph(p, size=font_size, color=color, bold=bold, align=align)
    return tb

def add_chip(slide, left, top, width, height, text, fill, color=WHITE, size=11):
    chip = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    chip.fill.solid()
    chip.fill.fore_color.rgb = fill
    chip.line.color.rgb = fill
    chip.line.width = Pt(1)

    tf = chip.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = Inches(0.06)
    tf.margin_right = Inches(0.06)
    tf.margin_top = Inches(0.02)
    tf.margin_bottom = Inches(0.02)

    p = tf.paragraphs[0]
    p.text = text
    format_paragraph(p, size=size, color=color, bold=True, align=PP_ALIGN.CENTER)
    return chip

def add_card(slide, left, top, width, height, title, bullets=None,
             fill=CARD, border=LIGHT, accent=BLUE,
             title_size=16, body_size=12,
             title_color=NAVY, body_color=TEXT):
    card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    card.fill.solid()
    card.fill.fore_color.rgb = fill
    card.line.color.rgb = border
    card.line.width = Pt(1)

    # accent strip
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, Inches(0.12), height)
    bar.fill.solid()
    bar.fill.fore_color.rgb = accent
    bar.line.color.rgb = accent
    bar.line.width = Pt(0.5)

    tf = card.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    tf.vertical_anchor = MSO_ANCHOR.TOP
    tf.margin_left = Inches(0.22)
    tf.margin_right = Inches(0.12)
    tf.margin_top = Inches(0.10)
    tf.margin_bottom = Inches(0.08)

    p = tf.paragraphs[0]
    p.text = title
    format_paragraph(p, size=title_size, color=title_color, bold=True)

    if bullets:
        for b in bullets:
            p = tf.add_paragraph()
            p.text = f"• {b}"
            format_paragraph(p, size=body_size, color=body_color, bold=False)

    return card

def add_stat_card(slide, left, top, width, height, value, label, accent=BLUE,
                  value_size=28, label_size=11, fill=CARD):
    card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    card.fill.solid()
    card.fill.fore_color.rgb = fill
    card.line.color.rgb = LIGHT
    card.line.width = Pt(1)

    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, Inches(0.12), height)
    bar.fill.solid()
    bar.fill.fore_color.rgb = accent
    bar.line.color.rgb = accent
    bar.line.width = Pt(0.5)

    tf = card.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = Inches(0.22)
    tf.margin_right = Inches(0.12)
    tf.margin_top = Inches(0.08)
    tf.margin_bottom = Inches(0.08)

    p = tf.paragraphs[0]
    p.text = value
    format_paragraph(p, size=value_size, color=NAVY, bold=True, align=PP_ALIGN.CENTER)

    p = tf.add_paragraph()
    p.text = label
    format_paragraph(p, size=label_size, color=MUTED, bold=False, align=PP_ALIGN.CENTER)

    return card

def add_header(slide, title, subtitle, accent=BLUE):
    # top chrome
    band = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, Inches(0.22))
    band.fill.solid()
    band.fill.fore_color.rgb = NAVY
    band.line.color.rgb = NAVY

    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, Inches(0.22), SLIDE_W, Inches(0.05))
    line.fill.solid()
    line.fill.fore_color.rgb = accent
    line.line.color.rgb = accent

    add_textbox(slide, Inches(0.60), Inches(0.45), Inches(11.3), Inches(0.38),
                title, font_size=24, color=NAVY, bold=True)

    add_textbox(slide, Inches(0.60), Inches(0.86), Inches(11.9), Inches(0.42),
                subtitle, font_size=10.5, color=MUTED, bold=False)

def add_footer(slide, page_num, total=15, dark=False):
    line_color = RGBColor(51, 65, 85) if dark else LIGHT
    text_color = WHITE if dark else MUTED

    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.60), Inches(6.93), Inches(12.15), Inches(0.02))
    line.fill.solid()
    line.fill.fore_color.rgb = line_color
    line.line.color.rgb = line_color

    add_textbox(slide, Inches(0.60), Inches(6.97), Inches(4.5), Inches(0.22),
                WEBSITE, font_size=9.5, color=text_color, bold=False)
    add_textbox(slide, Inches(12.05), Inches(6.95), Inches(1.05), Inches(0.24),
                f"{page_num:02d}/{total:02d}", font_size=9.5, color=text_color, bold=True, align=PP_ALIGN.RIGHT)

def add_transition(slide):
    # Simple fade transition in OOXML
    trans = OxmlElement("p:transition")
    trans.set("advClick", "1")
    trans.set("spd", "med")
    trans.append(OxmlElement("p:fade"))

    root = slide._element
    inserted = False
    for idx, child in enumerate(list(root)):
        if child.tag.endswith("timing"):
            root.insert(idx, trans)
            inserted = True
            break
    if not inserted:
        root.append(trans)

def set_props(prs):
    prs.core_properties.title = "Prepium School Pitch Deck"
    prs.core_properties.subject = "Prepium"
    prs.core_properties.author = "Prepium"
    prs.core_properties.company = "Prepium"
    prs.core_properties.comments = "Generated via python-pptx"

def style_table_cell(cell, text, size=10.5, color=TEXT, bold=False, fill=WHITE, align=PP_ALIGN.CENTER):
    cell.text = text
    cell.fill.solid()
    cell.fill.fore_color.rgb = fill
    cell.text_frame.word_wrap = True
    cell.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    cell.text_frame.margin_left = Inches(0.05)
    cell.text_frame.margin_right = Inches(0.05)
    cell.text_frame.margin_top = Inches(0.03)
    cell.text_frame.margin_bottom = Inches(0.03)

    for p in cell.text_frame.paragraphs:
        p.alignment = align
        for r in p.runs:
            r.font.name = FONT
            r.font.size = Pt(size)
            r.font.bold = bold
            r.font.color.rgb = color

# =========================
# BUILD DECK
# =========================
def build_deck(output_file=OUTPUT_FILE):
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    set_props(prs)
    blank = prs.slide_layouts[6]

    # ========== Slide 1: Cover ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, NAVY)

    # Decorative shapes
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(10.25), Inches(-0.85), Inches(4.2), Inches(4.2))
    s.fill.solid(); s.fill.fore_color.rgb = BLUE; s.line.color.rgb = BLUE
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(-1.2), Inches(5.8), Inches(3.4), Inches(3.4))
    s.fill.solid(); s.fill.fore_color.rgb = CYAN; s.line.color.rgb = CYAN
    s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(8.95), Inches(5.95), Inches(4.0), Inches(0.45))
    s.fill.solid(); s.fill.fore_color.rgb = GREEN; s.line.color.rgb = GREEN

    add_chip(slide, Inches(0.60), Inches(0.55), Inches(2.7), Inches(0.35), "PREPIUM SCHOOL PITCH DECK", CYAN, WHITE, 10)

    add_textbox(slide, Inches(0.60), Inches(1.15), Inches(6.5), Inches(0.75),
                "Prepium", font_size=42, color=WHITE, bold=True)
    add_textbox(slide, Inches(0.60), Inches(1.95), Inches(7.4), Inches(0.45),
                "Turn every student's phone into a personal exam preparation centre.",
                font_size=20, color=CYAN, bold=False)

    add_textbox(slide, Inches(0.60), Inches(2.45), Inches(6.8), Inches(0.65),
                "Practice questions, AI study tools, CGPA tracking, deadlines, timetables,\nchat, and alerts — all in one mobile-first academic platform.",
                font_size=13.5, color=RGBColor(226, 232, 240), bold=False)

    add_chip(slide, Inches(0.60), Inches(3.35), Inches(1.15), Inches(0.38), "Practice", BLUE, WHITE, 10)
    add_chip(slide, Inches(1.82), Inches(3.35), Inches(1.42), Inches(0.38), "Track CGPA", GREEN, WHITE, 10)
    add_chip(slide, Inches(3.32), Inches(3.35), Inches(1.48), Inches(0.38), "Stay Organized", ORANGE, WHITE, 10)

    add_chip(slide, Inches(0.60), Inches(4.15), Inches(1.70), Inches(0.40), "12 modules", WHITE, NAVY, 10)
    add_chip(slide, Inches(2.38), Inches(4.15), Inches(1.62), Inches(0.40), "35 screens", WHITE, NAVY, 10)
    add_chip(slide, Inches(4.08), Inches(4.15), Inches(2.05), Inches(0.40), "₦1,000 lifetime", WHITE, NAVY, 10)

    add_card(
        slide, Inches(8.25), Inches(1.25), Inches(4.45), Inches(4.90),
        "Everything students need",
        bullets=[
            "Timed CBT-style practice exams",
            "AI questions from any PDF lecture note",
            "CGPA, deadlines, timetable, and study library",
            "Community chat, leaderboards, and admin alerts"
        ],
        fill=WHITE, border=LIGHT, accent=CYAN, title_size=17, body_size=13, title_color=NAVY, body_color=TEXT
    )

    add_textbox(slide, Inches(8.30), Inches(6.28), Inches(4.25), Inches(0.32),
                WEBSITE, font_size=11, color=WHITE, bold=True, align=PP_ALIGN.RIGHT)
    add_footer(slide, 1, dark=True)

    # ========== Slide 2: Problem ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "The Problem",
        "Nigerian university students struggle because study resources are scattered, unstructured, and time-consuming to access.",
        accent=ORANGE
    )

    add_card(
        slide, Inches(0.60), Inches(1.55), Inches(5.65), Inches(4.80),
        "Students study in chaos",
        bullets=[
            "Past questions live in WhatsApp groups, USB drives, and photocopy shops",
            "Students waste hours searching instead of actually studying",
            "There is no central place for materials, deadlines, or collaboration",
            "Most study sessions have no schedule, timer, or accountability"
        ],
        fill=WHITE, border=LIGHT, accent=ORANGE, title_size=18, body_size=12.5
    )

    add_card(slide, Inches(6.50), Inches(1.55), Inches(3.00), Inches(2.20),
             "Scattered materials",
             ["Past questions everywhere", "No single source of truth"],
             accent=RED, title_size=15, body_size=11.5)
    add_card(slide, Inches(9.65), Inches(1.55), Inches(3.08), Inches(2.20),
             "No CGPA clarity",
             ["Students do not know where they stand", "Progress is hard to track"],
             accent=PURPLE, title_size=15, body_size=11.5)
    add_card(slide, Inches(6.50), Inches(4.00), Inches(3.00), Inches(2.35),
             "No structure",
             ["No timetable", "No timer", "No accountability"],
             accent=BLUE, title_size=15, body_size=11.5)
    add_card(slide, Inches(9.65), Inches(4.00), Inches(3.08), Inches(2.35),
             "Wasted effort",
             ["Hours spent searching for questions", "Less time spent studying"],
             accent=GREEN, title_size=15, body_size=11.5)

    add_footer(slide, 2)

    # ========== Slide 3: Solution Overview ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "The Solution",
        "Prepium is a mobile-first academic productivity ecosystem that gives students everything they need to prepare, track, and stay organized.",
        accent=CYAN
    )

    add_card(
        slide, Inches(0.60), Inches(1.55), Inches(3.88), Inches(4.65),
        "1. Practice",
        bullets=[
            "CBT-style exam engine with timer",
            "AI-generated quizzes from PDFs",
            "Daily challenge arena"
        ],
        accent=BLUE, title_size=16, body_size=12
    )
    add_card(
        slide, Inches(4.73), Inches(1.55), Inches(3.88), Inches(4.65),
        "2. Track",
        bullets=[
            "CGPA calculator and degree class",
            "Progress history and real-time updates",
            "Deadlines, reminders, and alerts"
        ],
        accent=GREEN, title_size=16, body_size=12
    )
    add_card(
        slide, Inches(8.86), Inches(1.55), Inches(3.88), Inches(4.65),
        "3. Organize",
        bullets=[
            "Study library for every school",
            "Weekly timetable and Pomodoro focus timer",
            "Community chat and direct messaging"
        ],
        accent=ORANGE, title_size=16, body_size=12
    )

    add_textbox(slide, Inches(0.60), Inches(6.42), Inches(12.0), Inches(0.30),
                "Not just a question bank — a complete academic productivity system.",
                font_size=12.5, color=MUTED, bold=True)
    add_footer(slide, 3)

    # ========== Slide 4: Practice Exam Engine ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "Practice Exam Engine",
        "Students choose their courses, set the number of questions, start a timer, and take a real CBT-style practice test.",
        accent=BLUE
    )

    add_card(
        slide, Inches(0.60), Inches(1.55), Inches(6.25), Inches(4.85),
        "How it works",
        bullets=[
            "Select one or more courses",
            "Choose the number of questions",
            "Start a timed exam just like the real thing",
            "Get instant score, subject breakdown, and explanations"
        ],
        accent=BLUE, title_size=18, body_size=12.5
    )

    add_stat_card(slide, Inches(7.05), Inches(1.55), Inches(5.68), Inches(1.55),
                  "Instant scoring", "See results the moment you submit", accent=GREEN, value_size=22)
    add_card(
        slide, Inches(7.05), Inches(3.30), Inches(5.68), Inches(3.10),
        "Built for confidence",
        bullets=[
            "Mimics the actual exam experience",
            "Lets students review every question",
            "Shows where they are strong and weak"
        ],
        accent=CYAN, title_size=16, body_size=12.2
    )

    add_footer(slide, 4)

    # ========== Slide 5: AI Quiz Generator ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "AI-Powered Quiz Generator",
        "Students upload any PDF lecture note and Prepium automatically generates practice questions from that exact material.",
        accent=PURPLE
    )

    add_card(
        slide, Inches(0.60), Inches(1.55), Inches(6.20), Inches(4.85),
        "From lecture note to quiz in seconds",
        bullets=[
            "Upload a PDF handout or lecture note",
            "The system extracts the content and generates questions",
            "Students practice the exact material they are learning",
            "No waiting for someone to compile past questions"
        ],
        accent=PURPLE, title_size=18, body_size=12.5
    )
    add_card(
        slide, Inches(7.00), Inches(1.55), Inches(5.72), Inches(2.20),
        "Why students love it",
        bullets=[
            "Personalized exam prep",
            "Fast revision before tests and exams"
        ],
        accent=GREEN, title_size=15, body_size=11.5
    )
    add_card(
        slide, Inches(7.00), Inches(4.00), Inches(5.72), Inches(2.40),
        "Perfect for",
        bullets=[
            "Lecture notes", "Handouts", "Course manuals", "Revision packs"
        ],
        accent=BLUE, title_size=15, body_size=11.5
    )

    add_footer(slide, 5)

    # ========== Slide 6: Daily Challenge + Library ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "Daily Challenge Arena + Study Library",
        "Prepium builds a habit of daily practice and keeps every course material organized in one central library.",
        accent=GREEN
    )

    add_card(
        slide, Inches(0.60), Inches(1.55), Inches(5.95), Inches(4.85),
        "Daily Challenge Arena",
        bullets=[
            "10 new questions released every day",
            "Live leaderboard across campus",
            "Healthy competition keeps students coming back",
            "Short daily practice turns into long-term discipline"
        ],
        accent=GREEN, title_size=17, body_size=12.2
    )
    add_card(
        slide, Inches(6.80), Inches(1.55), Inches(5.92), Inches(4.85),
        "Study Library",
        bullets=[
            "University-specific course collections",
            "Google Drive-linked materials for each course",
            "Students can upload and organize their own notes, past questions, and documents",
            "Accessible anytime from any device"
        ],
        accent=BLUE, title_size=17, body_size=12.2
    )

    add_footer(slide, 6)

    # ========== Slide 7: CGPA Calculator ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "CGPA Calculator & Academic Tracker",
        "Students enter their courses, credit units, and grades to calculate CGPA in real time using the correct grading scale.",
        accent=GREEN
    )

    add_stat_card(slide, Inches(0.60), Inches(1.55), Inches(5.75), Inches(4.85),
                  "CGPA 4.56", "First Class on a 5.0 scale", accent=GREEN, value_size=30, label_size=13)

    add_card(
        slide, Inches(6.55), Inches(1.55), Inches(5.98), Inches(2.15),
        "What it shows",
        bullets=[
            "Degree class: First Class, Second Class Upper, and more",
            "Live updates as new results are added",
            "Progress snapshot by semester and course"
        ],
        accent=BLUE, title_size=15.5, body_size=11.8
    )
    add_card(
        slide, Inches(6.55), Inches(4.00), Inches(5.98), Inches(2.40),
        "Other useful details",
        bullets=[
            "Supports 4.0 and 5.0 grading systems",
            "Can carry forward CGPA from another institution",
            "Helps students know what they need to improve"
        ],
        accent=PURPLE, title_size=15.5, body_size=11.8
    )

    add_footer(slide, 7)

    # ========== Slide 8: Productivity Tools ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "Deadlines, Pomodoro & Timetable",
        "Prepium helps students stay on schedule, stay focused, and stay accountable.",
        accent=ORANGE
    )

    add_card(
        slide, Inches(0.60), Inches(1.55), Inches(3.88), Inches(4.80),
        "Deadline Tracker",
        bullets=[
            "Set assignment and exam deadlines with date and time",
            "Floating countdown on the dashboard",
            "Email notifications before and after deadlines"
        ],
        accent=ORANGE, title_size=15.5, body_size=11.8
    )
    add_card(
        slide, Inches(4.73), Inches(1.55), Inches(3.88), Inches(4.80),
        "Pomodoro Focus Timer",
        bullets=[
            "Focused study intervals",
            "Breaks work into manageable sessions",
            "Keeps students away from social media"
        ],
        accent=BLUE, title_size=15.5, body_size=11.8
    )
    add_card(
        slide, Inches(8.86), Inches(1.55), Inches(3.88), Inches(4.80),
        "Weekly Timetable",
        bullets=[
            "Course name, day, time, and venue",
            "Always accessible from the phone",
            "Makes class schedules easy to follow"
        ],
        accent=GREEN, title_size=15.5, body_size=11.8
    )

    add_footer(slide, 8)

    # ========== Slide 9: Community + Notifications ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "Community Chat & Notifications",
        "Prepium keeps students connected without leaving the app.",
        accent=CYAN
    )

    add_card(
        slide, Inches(0.60), Inches(1.55), Inches(6.15), Inches(4.85),
        "WhatsApp-style campus chat",
        bullets=[
            "Join a university-specific group chat",
            "Message classmates directly",
            "Coordinate study sessions and share updates"
        ],
        accent=CYAN, title_size=17, body_size=12.2
    )
    add_card(
        slide, Inches(7.00), Inches(1.55), Inches(5.72), Inches(4.85),
        "Admin notifications & alerts",
        bullets=[
            "Exam reminders",
            "New materials",
            "Maintenance notices",
            "Important announcements to all students"
        ],
        accent=BLUE, title_size=17, body_size=12.2
    )

    add_footer(slide, 9)

    # ========== Slide 10: Student Journey ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "How It Works",
        "A simple student journey from sign-up to daily engagement and referrals.",
        accent=BLUE
    )

    add_textbox(slide, Inches(0.60), Inches(1.45), Inches(12.0), Inches(0.22),
                "From first login to lifetime use",
                font_size=11.5, color=MUTED, bold=True)

    steps = [
        ("1. Sign Up", "Choose university, enter email, create password", BLUE),
        ("2. Browse Courses", "See all available subjects for their school", GREEN),
        ("3. Practice", "Take timed CBT exams or generate AI quizzes", PURPLE),
        ("4. Track Progress", "View quiz history, scores, and CGPA in real time", ORANGE),
        ("5. Compete", "Climb the daily challenge leaderboard", CYAN),
        ("6. Stay Organized", "Set deadlines, build timetables, join chats", RED),
        ("7. Earn & Share", "Become an ambassador and refer friends", NAVY),
    ]

    gap = Inches(0.12)
    x = Inches(0.60)
    card_w = Inches(1.62)
    card_h = Inches(2.55)
    y = Inches(2.00)

    for title, body, accent in steps:
        add_card(
            slide, x, y, card_w, card_h,
            title, bullets=[body],
            accent=accent, title_size=10.5, body_size=8.8
        )
        x = x + card_w + gap

    # subtle baseline
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.75), Inches(3.45), Inches(11.85), Inches(0.04))
    line.fill.solid(); line.fill.fore_color.rgb = LIGHT; line.line.color.rgb = LIGHT

    add_footer(slide, 10)

    # ========== Slide 11: Benefits to Schools ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "How It Benefits Schools",
        "Prepium improves exam readiness while giving schools a modern digital engagement layer.",
        accent=GREEN
    )

    benefits = [
        ("Improved Exam Results", "Students practice regularly and score better."),
        ("Academic Tracking", "Students understand where they stand."),
        ("Reduced Cheating", "Prepared students are less likely to cut corners."),
        ("Digital Transition", "Move away from photocopy-dependent distribution."),
        ("Student Engagement", "Leaderboards and daily challenges keep students active."),
        ("Data & Analytics", "Track users, conversions, quiz attempts, and subjects."),
    ]

    positions = [
        (0.60, 1.55), (4.73, 1.55), (8.86, 1.55),
        (0.60, 3.55), (4.73, 3.55), (8.86, 3.55),
    ]

    for (title, body), (x, y) in zip(benefits, positions):
        add_card(
            slide, Inches(x), Inches(y), Inches(3.88), Inches(1.62),
            title, bullets=[body],
            accent=BLUE, title_size=13.8, body_size=10.5
        )

    add_footer(slide, 11)

    # ========== Slide 12: Competitive Advantage ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "Competitive Advantage",
        "Prepium stands out because it combines AI, productivity, community, and affordability in one app.",
        accent=PURPLE
    )

    rows, cols = 8, 4
    table_shape = slide.shapes.add_table(rows, cols, Inches(0.60), Inches(1.55), Inches(12.15), Inches(4.95))
    table = table_shape.table

    widths = [2.80, 2.45, 3.35, 3.55]
    for i, w in enumerate(widths):
        table.columns[i].width = Inches(w)

    headers = ["Capability", "Prepium", "Generic CBT App", "Photocopy / USB"]
    for i, h in enumerate(headers):
        cell = table.cell(0, i)
        style_table_cell(cell, h, size=11, color=WHITE, bold=True, fill=NAVY, align=PP_ALIGN.CENTER)

    feature_fill = VERY_LIGHT
    yes_fill = RGBColor(220, 252, 231)
    no_fill = RGBColor(254, 242, 242)
    partial_fill = RGBColor(255, 247, 237)

    rows_data = [
        ("AI quiz from PDFs", "Yes", "No", "No"),
        ("CGPA tracker", "Yes", "No", "No"),
        ("Daily leaderboard", "Yes", "No", "No"),
        ("Study library", "Yes", "Partial", "Manual"),
        ("Deadlines + Pomodoro", "Yes", "No", "No"),
        ("Mobile-first", "Yes", "Sometimes", "No"),
        ("Lifetime access", "₦1,000", "Monthly", "Repeated cost"),
    ]

    for r, (feature, p, g, u) in enumerate(rows_data, start=1):
        style_table_cell(table.cell(r, 0), feature, size=10.5, color=NAVY, bold=True, fill=feature_fill, align=PP_ALIGN.LEFT)

        # Prepium
        prep_color = GREEN if p in ("Yes", "₦1,000") else MUTED
        prep_fill = yes_fill if p in ("Yes", "₦1,000") else feature_fill
        style_table_cell(table.cell(r, 1), p, size=10.5, color=prep_color, bold=True, fill=prep_fill)

        # Generic CBT App
        gen_color = ORANGE if g == "Sometimes" else (RED if g in ("No", "Monthly") else MUTED)
        gen_fill = partial_fill if g == "Sometimes" else (no_fill if g in ("No", "Monthly") else feature_fill)
        style_table_cell(table.cell(r, 2), g, size=10.5, color=gen_color, bold=(g in ("Partial", "Sometimes")), fill=gen_fill)

        # Photocopy / USB
        usb_color = RED if u in ("No", "Repeated cost") else MUTED
        usb_fill = no_fill if u in ("No", "Repeated cost") else feature_fill
        style_table_cell(table.cell(r, 3), u, size=10.5, color=usb_color, bold=(u != "No"), fill=usb_fill)

    add_textbox(slide, Inches(0.60), Inches(6.58), Inches(12.1), Inches(0.22),
                "Why it wins: Prepium is the only platform here that combines AI quiz generation, CGPA tracking, gamification, and student organization.",
                font_size=10.5, color=MUTED, bold=True)

    add_footer(slide, 12)

    # ========== Slide 13: Pricing & Growth ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "Pricing & Growth Model",
        "Prepium is designed to be affordable, simple, and easy to spread across campuses.",
        accent=GREEN
    )

    # Large pricing card
    price_card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.60), Inches(1.55), Inches(6.45), Inches(4.85))
    price_card.fill.solid()
    price_card.fill.fore_color.rgb = WHITE
    price_card.line.color.rgb = LIGHT
    price_card.line.width = Pt(1)

    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.60), Inches(1.55), Inches(0.12), Inches(4.85))
    bar.fill.solid(); bar.fill.fore_color.rgb = GREEN; bar.line.color.rgb = GREEN

    add_textbox(slide, Inches(0.88), Inches(1.85), Inches(4.6), Inches(0.40),
                "One-time lifetime access", font_size=15, color=MUTED, bold=True)
    add_textbox(slide, Inches(0.88), Inches(2.20), Inches(4.9), Inches(0.85),
                "₦1,000", font_size=34, color=NAVY, bold=True)
    add_textbox(slide, Inches(0.88), Inches(2.95), Inches(5.8), Inches(0.32),
                "Cheaper than a single photocopy bundle.", font_size=13, color=GREEN, bold=True)

    add_card(
        slide, Inches(0.88), Inches(3.35), Inches(5.75), Inches(1.60),
        "What students get",
        bullets=[
            "2 free quizzes before upgrade",
            "All major academic modules",
            "No subscriptions, no monthly pressure"
        ],
        accent=BLUE, title_size=14.5, body_size=10.8
    )

    add_card(
        slide, Inches(7.28), Inches(1.55), Inches(5.55), Inches(2.15),
        "Free Tier",
        bullets=[
            "2 practice quizzes",
            "Upgrade only when they see value"
        ],
        accent=ORANGE, title_size=16, body_size=11.8
    )
    add_card(
        slide, Inches(7.28), Inches(4.00), Inches(5.55), Inches(2.40),
        "Ambassador Program",
        bullets=[
            "Students can refer friends",
            "Campus reps can earn money",
            "Growth spreads naturally inside each university"
        ],
        accent=PURPLE, title_size=16, body_size=11.8
    )

    add_footer(slide, 13)

    # ========== Slide 14: Metrics & Admin ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, BG)
    add_header(
        slide,
        "Current Metrics",
        "Prepium already has the structure needed for product rollout and campus-scale growth.",
        accent=BLUE
    )

    stats = [
        ("12", "Major modules", BLUE),
        ("35", "Student screens", GREEN),
        ("12", "Admin panels", PURPLE),
        ("∞", "Question bank", ORANGE),
    ]
    xs = [0.60, 3.70, 6.80, 9.90]
    for (value, label, accent), x in zip(stats, xs):
        add_stat_card(slide, Inches(x), Inches(1.55), Inches(2.75), Inches(1.55),
                      value, label, accent=accent, value_size=28, label_size=11)

    add_card(
        slide, Inches(0.60), Inches(3.35), Inches(12.05), Inches(3.05),
        "Admin dashboard highlights",
        bullets=[
            "Bulk import questions using JSON",
            "See total users, premium conversions, quiz attempts, and popular subjects",
            "Support all Nigerian universities from one platform"
        ],
        accent=CYAN, title_size=17, body_size=12
    )

    add_chip(slide, Inches(0.60), Inches(6.48), Inches(2.55), Inches(0.34), "All Nigerian universities", GREEN, WHITE, 10)
    add_chip(slide, Inches(3.22), Inches(6.48), Inches(2.35), Inches(0.34), "Mobile-first design", BLUE, WHITE, 10)
    add_chip(slide, Inches(5.64), Inches(6.48), Inches(2.05), Inches(0.34), "JSON imports", PURPLE, WHITE, 10)

    add_footer(slide, 14)

    # ========== Slide 15: Ask / Closing ==========
    slide = prs.slides.add_slide(blank)
    add_transition(slide)
    set_bg(slide, NAVY)

    # Decorative shapes
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(10.10), Inches(-0.85), Inches(4.2), Inches(4.2))
    s.fill.solid(); s.fill.fore_color.rgb = BLUE; s.line.color.rgb = BLUE
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(-1.15), Inches(5.75), Inches(3.4), Inches(3.4))
    s.fill.solid(); s.fill.fore_color.rgb = CYAN; s.line.color.rgb = CYAN

    add_textbox(slide, Inches(0.60), Inches(1.00), Inches(6.8), Inches(0.55),
                "Partner with Prepium", font_size=30, color=WHITE, bold=True)
    add_textbox(slide, Inches(0.60), Inches(1.65), Inches(6.8), Inches(0.55),
                "Give your students access to a smarter, more organized way to prepare for exams.",
                font_size=17, color=CYAN, bold=False)
    add_textbox(slide, Inches(0.60), Inches(2.30), Inches(6.9), Inches(1.00),
                "Whether as a supplementary tool or an official exam-prep platform,\nPrepium enhances the academic experience without requiring infrastructure investment.",
                font_size=13.2, color=RGBColor(226, 232, 240), bold=False)

    add_chip(slide, Inches(0.60), Inches(3.55), Inches(1.55), Inches(0.38), "Pilot-ready", GREEN, WHITE, 10)
    add_chip(slide, Inches(2.25), Inches(3.55), Inches(1.85), Inches(0.38), "Student-focused", BLUE, WHITE, 10)
    add_chip(slide, Inches(4.20), Inches(3.55), Inches(1.95), Inches(0.38), "Low-cost rollout", ORANGE, WHITE, 10)

    # closing card
    add_card(
        slide, Inches(8.25), Inches(1.35), Inches(4.45), Inches(4.95),
        "Website & next step",
        bullets=[
            f"Visit: {WEBSITE}",
            "Start with a pilot group or campus rollout",
            "Use Prepium as a supplementary or official exam-prep tool",
            f"Address: {ADDRESS_LINE}"
        ],
        fill=WHITE, border=LIGHT, accent=CYAN, title_size=17, body_size=12, title_color=NAVY, body_color=TEXT
    )

    add_textbox(slide, Inches(8.35), Inches(5.95), Inches(4.25), Inches(0.30),
                WEBSITE, font_size=13, color=CYAN, bold=True, align=PP_ALIGN.RIGHT)
    add_footer(slide, 15, dark=True)

    prs.save(output_file)
    print(f"Saved to: {output_file}")

if __name__ == "__main__":
    build_deck()