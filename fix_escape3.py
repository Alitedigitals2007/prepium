with open('views/ai-quiz.ejs', 'r', encoding='utf-8') as f:
    content = f.read()

# The file currently has literal & < > in the replacement strings
# We need to replace them with the HTML entity versions
content = content.replace(
    "return (text||'').replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>');",
    "return (text||'').replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>');"
)

with open('views/ai-quiz.ejs', 'w', encoding='utf-8') as f:
    f.write(content)
print('Fixed')