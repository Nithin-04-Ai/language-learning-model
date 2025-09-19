
import os
from datetime import datetime, timedelta
from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from passlib.hash import bcrypt
import jwt
from functools import wraps
from flask_cors import CORS
import smtplib
from email.message import EmailMessage
import openai

from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
CORS(app, origins=os.getenv("FRONTEND_ORIGIN", "*"))

# Config
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///data.db'
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'devsecret')
db = SQLAlchemy(app)

JWT_SECRET = os.getenv("JWT_SECRET", "jwt-secret")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if OPENAI_API_KEY:
    openai.api_key = OPENAI_API_KEY

# Models
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120))
    email = db.Column(db.String(200), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    signup_date = db.Column(db.DateTime, default=datetime.utcnow)

    def verify_password(self, pwd):
        return bcrypt.verify(pwd, self.password_hash)

class Language(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True)

class UserLanguage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    lang_id = db.Column(db.Integer, db.ForeignKey('language.id'))
    progress = db.Column(db.Float, default=0.0)

class Exercise(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    lang_id = db.Column(db.Integer, db.ForeignKey('language.id'))
    type = db.Column(db.String(50))  # quiz, flashcard, listening, translation
    content = db.Column(db.Text)     # JSON or plain text
    difficulty = db.Column(db.Integer, default=1)

class Progress(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    ex_id = db.Column(db.Integer, db.ForeignKey('exercise.id'))
    score = db.Column(db.Integer)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)


# Init DB helper
@app.before_first_request
def create_tables():
    db.create_all()
    # Seed languages if empty
    seed = ["English", "Spanish", "French", "Hindi", "Chinese", "Japanese"]
    for name in seed:
        if not Language.query.filter_by(name=name).first():
            db.session.add(Language(name=name))
    db.session.commit()

# Auth utilities
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            auth = request.headers.get('Authorization')
            if auth and auth.startswith("Bearer "):
                token = auth.split(" ")[1]
        if not token:
            return jsonify({"message": "Token is missing!"}), 401
        try:
            data = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            current_user = User.query.get(data['user_id'])
            if not current_user:
                raise Exception("User not found")
        except Exception as e:
            return jsonify({"message": "Token is invalid!", "error": str(e)}), 401
        return f(current_user, *args, **kwargs)
    return decorated

# Routes
@app.route('/api/signup', methods=['POST'])
def signup():
    data = request.json
    if User.query.filter_by(email=data['email']).first():
        return jsonify({"message":"Email already registered"}), 400
    pwd_hash = bcrypt.hash(data['password'])
    user = User(name=data.get('name',''), email=data['email'], password_hash=pwd_hash)
    db.session.add(user)
    db.session.commit()
    token = jwt.encode({"user_id": user.id, "exp": datetime.utcnow()+timedelta(days=7)}, JWT_SECRET, algorithm="HS256")
    return jsonify({"token": token, "user": {"id": user.id, "email": user.email, "name": user.name}})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    user = User.query.filter_by(email=data['email']).first()
    if not user or not user.verify_password(data['password']):
        return jsonify({"message":"Invalid credentials"}), 401
    token = jwt.encode({"user_id": user.id, "exp": datetime.utcnow()+timedelta(days=7)}, JWT_SECRET, algorithm="HS256")
    return jsonify({"token": token, "user": {"id": user.id, "email": user.email, "name": user.name}})

@app.route('/api/languages', methods=['GET'])
@token_required
def list_languages(current_user):
    langs = Language.query.all()
    return jsonify([{"id": l.id, "name": l.name} for l in langs])

@app.route('/api/user/languages', methods=['GET', 'POST'])
@token_required
def user_languages(current_user):
    if request.method == 'GET':
        ul = UserLanguage.query.filter_by(user_id=current_user.id).all()
        out = []
        for r in ul:
            lang = Language.query.get(r.lang_id)
            out.append({"lang_id": lang.id, "lang_name": lang.name, "progress": r.progress})
        return jsonify(out)
    else:
        data = request.json
        lang_id = data['lang_id']
        if UserLanguage.query.filter_by(user_id=current_user.id, lang_id=lang_id).first():
            return jsonify({"message":"Already added"}), 400
        r = UserLanguage(user_id=current_user.id, lang_id=lang_id)
        db.session.add(r)
        db.session.commit()
        return jsonify({"message":"Language added"})

@app.route('/api/lessons/<int:lang_id>', methods=['GET'])
@token_required
def get_lessons(current_user, lang_id):
    # Minimal demo: return few lessons (in real app store in DB or filesystem)
    lessons = [
        {"id": 1, "title": "Basics: Greetings", "content": "Hello - Hi - How are you?", "audio_url": "", "video_url": ""},
        {"id": 2, "title": "Basic Phrases", "content": "Please, Thank you, Sorry", "audio_url": "", "video_url": ""}
    ]
    return jsonify({"language_id":lang_id, "lessons":lessons})

@app.route('/api/exercises/<int:lang_id>', methods=['GET'])
@token_required
def get_exercises(current_user, lang_id):
    # Simple personalization: choose exercises where difficulty matches user's progress rough level
    ul = UserLanguage.query.filter_by(user_id=current_user.id, lang_id=lang_id).first()
    prog = ul.progress if ul else 0.0
    difficulty = 1 if prog < 20 else (2 if prog < 50 else 3)
    # Return sample exercises
    exercises = [
        {"id": 101, "type": "flashcard", "content": {"word":"Hello", "translation":"Hola"}, "difficulty": difficulty},
        {"id": 102, "type": "translation", "content": {"text":"Good morning"}, "difficulty": difficulty}
    ]
    return jsonify({"exercises": exercises})

@app.route('/api/exercise/submit', methods=['POST'])
@token_required
def submit_exercise(current_user):
    data = request.json
    ex_id = data.get('ex_id')
    score = int(data.get('score',0))
    p = Progress(user_id=current_user.id, ex_id=ex_id, score=score)
    db.session.add(p)
    # update user-language progress roughly
    # Here ex_id mapping to language omitted; assume client sends lang_id
    lang_id = data.get('lang_id')
    if lang_id:
        ul = UserLanguage.query.filter_by(user_id=current_user.id, lang_id=lang_id).first()
        if not ul:
            ul = UserLanguage(user_id=current_user.id, lang_id=lang_id, progress=0.0)
            db.session.add(ul)
        # Simplified update: average progress increment
        ul.progress = min(100.0, ul.progress + score*0.5)
    db.session.commit()
    return jsonify({"message":"Recorded", "new_progress": ul.progress if lang_id else None})

@app.route('/api/translate', methods=['POST'])
@token_required
def translate(current_user):
    data = request.json
    text = data.get('text')
    src = data.get('src', 'auto')
    tgt = data.get('tgt', 'en')
    # Use OpenAI for simple translation if available
    if OPENAI_API_KEY:
        try:
            prompt = f"Translate the following text from {src} to {tgt}:\n\n{text}"
            resp = openai.ChatCompletion.create(model="gpt-4o-mini", messages=[{"role":"user","content":prompt}], max_tokens=200)
            translated = resp.choices[0].message['content'].strip()
            return jsonify({"translated": translated})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    else:
        # fallback naive stub
        return jsonify({"translated": f"[translated ({tgt})] {text}"})

@app.route('/api/chatbot', methods=['POST'])
@token_required
def chatbot(current_user):
    data = request.json
    prompt = data.get('message')
    # Very simple echo/chatbot using OpenAI if available
    if OPENAI_API_KEY:
        try:
            resp = openai.ChatCompletion.create(model="gpt-4o-mini", messages=[{"role":"user","content":prompt}], max_tokens=200)
            reply = resp.choices[0].message['content'].strip()
            return jsonify({"reply": reply})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    else:
        return jsonify({"reply": f"Bot stub: I heard '{prompt}'"})

# Email reminder (callable by scheduler like cron)
def send_email(to_email, subject, content):
    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", 587))
    user = os.getenv("SMTP_USER")
    pwd = os.getenv("SMTP_PASS")
    if not host or not user:
        print("SMTP not configured. Skipping email.")
        return False
    msg = EmailMessage()
    msg['Subject'] = subject
    msg['From'] = user
    msg['To'] = to_email
    msg.set_content(content)
    try:
        with smtplib.SMTP(host, port) as s:
            s.starttls()
            s.login(user, pwd)
            s.send_message(msg)
        return True
    except Exception as e:
        print("Email send failed:", e)
        return False

@app.route('/api/send_reminder', methods=['POST'])
def send_reminder():
    # This would be scheduled: iterate users and send email.
    users = User.query.all()
    sent = 0
    for u in users:
        content = f"Hi {u.name or u.email},\nThis is your daily reminder to practice your language lessons!\nVisit the app: {os.getenv('FRONTEND_ORIGIN')}"
        if send_email(u.email, "Daily Language Practice Reminder", content):
            sent += 1
    return jsonify({"sent": sent})

if __name__ == '__main__':
    app.run(debug=True, port=5000)
