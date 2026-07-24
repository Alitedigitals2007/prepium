with open('views/ai-quiz.ejs', 'r', encoding='utf-8') as f:
    content = f.read()
# Fix the escapeHtml function - use proper HTML entities
content = content.replace("replace(/&/g,'&')", "replace(/&/g,'&')")
content = content.replace("replace(/</g,'<')", "replace(/</g,'<')")
content = content.replace("replace(/>/g,'>')", "replace(/>/g,'>')")
with open('views/ai-quiz.ejs', 'w', encoding='utf-8') as f:
    f.write(content)
print('Fixed')