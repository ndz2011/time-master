"""
工作管理器 — Flask 后端
SQLite 持久化 + REST API + 前端托管
时间盒（TimeBox）架构：每段工作时间显式归属一个时间盒
"""

import os
import time
import random
from datetime import datetime, timezone

from flask import Flask, jsonify, request, render_template, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "tasks.db")

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)


# ─── Models ────────────────────────────────────────────────────────────────────

class Task(db.Model):
    __tablename__ = "tasks"
    id = db.Column(db.String(20), primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    desc = db.Column(db.String(500), default="")
    priority = db.Column(db.String(10), default="mid")   # high / mid / low
    done = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.Float, default=lambda: time.time())
    focus_secs = db.Column(db.Float, default=0)          # 累计计划内时间（关盒时累加）
    overtime_secs = db.Column(db.Float, default=0)       # 累计超出时间（关盒时累加）
    pause_secs = db.Column(db.Float, default=0)          # 累计暂停时间（关盒时累加）
    planned_secs = db.Column(db.Float, default=0)        # 单次时间盒默认预算

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "desc": self.desc or "",
            "priority": self.priority,
            "done": self.done,
            "created": self.created_at,
            "focusSecs": self.focus_secs or 0,
            "overtimeSecs": self.overtime_secs or 0,
            "pauseSecs": self.pause_secs or 0,
            "plannedSecs": self.planned_secs or 0,
        }


class TimeBox(db.Model):
    """一次工作会话的完整记录"""
    __tablename__ = "time_boxes"
    id = db.Column(db.String(20), primary_key=True)
    task_id = db.Column(db.String(20), nullable=False)
    budget_secs = db.Column(db.Float, nullable=False)           # 开盒时承诺的预算
    opened_at = db.Column(db.Float, nullable=False)             # epoch ms
    closed_at = db.Column(db.Float, default=None)               # epoch ms，null=活跃
    pause_started_at = db.Column(db.Float, default=None)        # 当前暂停开始时刻 epoch ms
    accumulated_pause_secs = db.Column(db.Float, default=0)     # 历史暂停累计（不含本次）
    focus_secs = db.Column(db.Float, default=0)                 # 关盒时写入
    overtime_secs = db.Column(db.Float, default=0)              # 关盒时写入
    status = db.Column(db.String(10), default="running")        # running|paused|closed

    def _now_ms(self):
        return time.time() * 1000

    def total_pause_secs(self):
        p = self.accumulated_pause_secs or 0
        if self.pause_started_at and self.status == "paused":
            p += (self._now_ms() - self.pause_started_at) / 1000
        return p

    def worked_secs(self):
        """实际工作时长（不含暂停），关盒后用 closed_at 计算"""
        end_ms = self.closed_at if self.closed_at else self._now_ms()
        raw = (end_ms - self.opened_at) / 1000
        return max(0, raw - self.total_pause_secs())

    def remaining_secs(self):
        return self.budget_secs - self.worked_secs()

    def live_overtime_secs(self):
        return max(0, self.worked_secs() - self.budget_secs)

    def to_dict(self):
        now_ms = self._now_ms()
        ws = self.worked_secs()
        rem = self.budget_secs - ws
        ot = max(0, ws - self.budget_secs)
        pct = min(100, ws / self.budget_secs * 100) if self.budget_secs > 0 else 0
        return {
            "id": self.id,
            "taskId": self.task_id,
            "budgetSecs": self.budget_secs,
            "openedAt": self.opened_at,
            "closedAt": self.closed_at,
            "pauseStartedAt": self.pause_started_at,
            "accumulatedPauseSecs": self.accumulated_pause_secs or 0,
            "focusSecs": self.focus_secs or 0,
            "overtimeSecs": self.overtime_secs or 0,
            "status": self.status,
            # live-computed fields (only meaningful for non-closed boxes)
            "workedSecs": ws,
            "remainingSecs": rem,
            "liveOvertimeSecs": ot,
            "progressPct": pct,
        }


class AppState(db.Model):
    """单例行 — id=1"""
    __tablename__ = "app_state"
    id = db.Column(db.Integer, primary_key=True, default=1)
    active_box_id = db.Column(db.String(20), default=None)   # 取代旧的7个计时字段
    notify_enabled = db.Column(db.Boolean, default=False)
    sound_enabled = db.Column(db.Boolean, default=True)
    filter_key = db.Column(db.String(20), default="all")
    default_budget_secs = db.Column(db.Float, default=1500)  # 新建盒时的默认预算（25min）
    # 旧字段保留供迁移兼容，不再写入
    current_task_id = db.Column(db.String(20), default="")
    timer_target = db.Column(db.Float, default=0)
    timer_running = db.Column(db.Boolean, default=False)
    timer_paused_remain = db.Column(db.Float, default=1500)
    interval_secs = db.Column(db.Float, default=1500)
    overtime_base_secs = db.Column(db.Float, default=0)
    overtime_paused_secs = db.Column(db.Float, default=0)
    pause_start = db.Column(db.Float, default=0)


# ─── Init DB ───────────────────────────────────────────────────────────────────

def init_db():
    data_dir = os.path.join(BASE_DIR, "data")
    os.makedirs(data_dir, exist_ok=True)
    with db.engine.connect() as conn:
        for sql in [
            # 旧版迁移（兼容）
            "ALTER TABLE tasks ADD COLUMN focus_secs REAL DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN overtime_secs REAL DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN pause_secs REAL DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN planned_secs REAL DEFAULT 0",
            "ALTER TABLE app_state ADD COLUMN overtime_base_secs REAL DEFAULT 0",
            "ALTER TABLE app_state ADD COLUMN overtime_paused_secs REAL DEFAULT 0",
            "ALTER TABLE app_state ADD COLUMN pause_start REAL DEFAULT 0",
            # 新版迁移
            "ALTER TABLE app_state ADD COLUMN active_box_id TEXT DEFAULT NULL",
            "ALTER TABLE app_state ADD COLUMN default_budget_secs REAL DEFAULT 1500",
        ]:
            try:
                conn.execute(text(sql))
            except Exception:
                pass
        conn.commit()
    db.create_all()
    if AppState.query.get(1) is None:
        db.session.add(AppState(id=1))
        db.session.commit()
    # 崩溃恢复：结清启动时遗留的活跃/暂停时间盒
    state = AppState.query.get(1)
    if state.active_box_id:
        box = TimeBox.query.get(state.active_box_id)
        if box and box.status in ("running", "paused"):
            t = Task.query.get(box.task_id)
            _close_box(box, t)
            db.session.commit()
            print(f"[init_db] 已自动结清遗留时间盒 {box.id}（task={box.task_id}）")


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _uid():
    return format(int(time.time()), "x") + "".join(random.choices("0123456789abcdef", k=6))

def _active_box():
    state = AppState.query.get(1)
    if not state.active_box_id:
        return None
    return TimeBox.query.get(state.active_box_id)

def _close_box(box, task):
    """关盒：计算并写入 focus/overtime，更新 task 缓存，清空 active_box_id"""
    # 若正在暂停，先把本次暂停时长并入 accumulated，再计算工作时长
    if box.status == "paused" and box.pause_started_at:
        dur = (time.time() * 1000 - box.pause_started_at) / 1000
        box.accumulated_pause_secs = (box.accumulated_pause_secs or 0) + dur
        box.pause_started_at = None

    ws = box.worked_secs()
    box.closed_at = time.time() * 1000
    box.status = "closed"
    box.focus_secs = min(ws, box.budget_secs)
    box.overtime_secs = max(0, ws - box.budget_secs)

    if task:
        task.focus_secs = (task.focus_secs or 0) + box.focus_secs
        task.overtime_secs = (task.overtime_secs or 0) + box.overtime_secs
        task.pause_secs = (task.pause_secs or 0) + (box.accumulated_pause_secs or 0)
    state = AppState.query.get(1)
    state.active_box_id = None


# ─── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    version = int(time.time() // 60)  # 每分钟变一次，强制刷新
    return render_template("index.html", v=version)

@app.route("/float.html")
def float_page():
    return render_template("float.html")

@app.route("/music/<path:filename>")
def music_file(filename):
    return send_from_directory(os.path.join(BASE_DIR, "static", "music"), filename)


# ── Tasks CRUD ──

@app.route("/api/tasks", methods=["GET"])
def get_tasks():
    tasks = Task.query.order_by(Task.created_at.desc()).all()
    return jsonify([t.to_dict() for t in tasks])

@app.route("/api/tasks", methods=["POST"])
def create_task():
    d = request.get_json(force=True)
    name = d.get("name", "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    try:
        planned = float(d.get("plannedSecs", 0))
        planned = max(0, planned)
    except (TypeError, ValueError):
        return jsonify({"error": "plannedSecs must be a number"}), 400
    t = Task(
        id=_uid(),
        name=name,
        desc=d.get("desc", "").strip(),
        priority=d.get("priority", "mid"),
        planned_secs=planned,
    )
    db.session.add(t)
    db.session.commit()
    return jsonify(t.to_dict()), 201

@app.route("/api/tasks/<tid>", methods=["PUT"])
def update_task(tid):
    t = Task.query.get(tid)
    if not t:
        return jsonify({"error": "not found"}), 404
    d = request.get_json(force=True)
    if "name" in d:
        name = d.get("name", "").strip()
        if not name:
            return jsonify({"error": "name required"}), 400
        t.name = name
    t.desc = d.get("desc", t.desc)
    t.priority = d.get("priority", t.priority)
    if "plannedSecs" in d:
        try:
            ps = float(d["plannedSecs"])
            t.planned_secs = max(0, ps)
        except (TypeError, ValueError):
            return jsonify({"error": "plannedSecs must be a number"}), 400
    db.session.commit()
    return jsonify(t.to_dict())

@app.route("/api/tasks/<tid>", methods=["DELETE"])
def delete_task(tid):
    t = Task.query.get(tid)
    if not t:
        return jsonify({"error": "not found"}), 404
    box = _active_box()
    if box and box.task_id == tid:
        _close_box(box, t)
    db.session.delete(t)
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/api/tasks/<tid>/toggle", methods=["POST"])
def toggle_done(tid):
    t = Task.query.get(tid)
    if not t:
        return jsonify({"error": "not found"}), 404
    t.done = not t.done
    # 不再自动关闭时间盒：允许用户在任务完成后继续记录验证时间
    box = _active_box()
    has_active_box = t.done and box and box.task_id == tid
    db.session.commit()
    d = t.to_dict()
    d["hasActiveBox"] = has_active_box
    return jsonify(d)

@app.route("/api/tasks/clear-done", methods=["POST"])
def clear_done():
    done_tasks = Task.query.filter(Task.done == True).all()
    box = _active_box()
    for t in done_tasks:
        if box and box.task_id == t.id:
            _close_box(box, t)
        db.session.delete(t)
    db.session.commit()
    return jsonify({"count": len(done_tasks)})

@app.route("/api/tasks/<tid>/boxes", methods=["GET"])
def get_task_boxes(tid):
    t = Task.query.get(tid)
    if not t:
        return jsonify({"error": "not found"}), 404
    boxes = TimeBox.query.filter_by(task_id=tid).order_by(TimeBox.opened_at.asc()).all()
    return jsonify([b.to_dict() for b in boxes])


# ── TimeBox API ──

@app.route("/api/boxes", methods=["POST"])
def open_box():
    """开盒。若已有活跃盒则先关闭。"""
    d = request.get_json(force=True)
    task_id = d.get("task_id", "").strip()
    try:
        budget_secs = float(d.get("budget_secs", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "budget_secs must be a number"}), 400
    if not task_id:
        return jsonify({"error": "task_id required"}), 400
    t = Task.query.get(task_id)
    if not t:
        return jsonify({"error": "task not found"}), 404
    if budget_secs <= 0:
        state = AppState.query.get(1)
        budget_secs = t.planned_secs or state.default_budget_secs or 1500

    # 关掉已有活跃盒
    old_box = _active_box()
    if old_box:
        old_task = Task.query.get(old_box.task_id)
        _close_box(old_box, old_task)

    box = TimeBox(
        id=_uid(),
        task_id=task_id,
        budget_secs=budget_secs,
        opened_at=time.time() * 1000,
        status="running",
        accumulated_pause_secs=0,
    )
    db.session.add(box)
    state = AppState.query.get(1)
    state.active_box_id = box.id
    db.session.commit()
    return jsonify(box.to_dict()), 201


@app.route("/api/boxes/active", methods=["GET"])
def get_active_box():
    box = _active_box()
    if not box:
        return jsonify(None)
    d = box.to_dict()
    # 附带任务名，方便前端直接用
    t = Task.query.get(box.task_id)
    d["taskName"] = t.name if t else ""
    return jsonify(d)


@app.route("/api/boxes/<bid>/pause", methods=["PUT"])
def pause_box(bid):
    box = TimeBox.query.get(bid)
    if not box or box.status != "running":
        return jsonify({"error": "not running"}), 400
    box.status = "paused"
    box.pause_started_at = time.time() * 1000
    db.session.commit()
    return jsonify(box.to_dict())


@app.route("/api/boxes/<bid>/resume", methods=["PUT"])
def resume_box(bid):
    box = TimeBox.query.get(bid)
    if not box or box.status != "paused":
        return jsonify({"error": "not paused"}), 400
    if box.pause_started_at:
        dur = (time.time() * 1000 - box.pause_started_at) / 1000
        box.accumulated_pause_secs = (box.accumulated_pause_secs or 0) + dur
    box.pause_started_at = None
    box.status = "running"
    db.session.commit()
    return jsonify(box.to_dict())


@app.route("/api/boxes/<bid>/close", methods=["PUT"])
def close_box(bid):
    box = TimeBox.query.get(bid)
    if not box or box.status == "closed":
        return jsonify({"error": "not active"}), 400
    # 若正在暂停，先结算暂停时间
    if box.status == "paused" and box.pause_started_at:
        dur = (time.time() * 1000 - box.pause_started_at) / 1000
        box.accumulated_pause_secs = (box.accumulated_pause_secs or 0) + dur
        box.pause_started_at = None
    t = Task.query.get(box.task_id)
    _close_box(box, t)
    db.session.commit()
    return jsonify(box.to_dict())


@app.route("/api/boxes/<bid>/extend", methods=["PUT"])
def extend_box(bid):
    box = TimeBox.query.get(bid)
    if not box or box.status == "closed":
        return jsonify({"error": "not active"}), 400
    d = request.get_json(force=True)
    try:
        add_secs = float(d.get("add_secs", 300))
    except (TypeError, ValueError):
        return jsonify({"error": "add_secs must be a number"}), 400
    if add_secs <= 0:
        return jsonify({"error": "add_secs must be positive"}), 400
    box.budget_secs += add_secs
    db.session.commit()
    return jsonify(box.to_dict())


@app.route("/api/boxes", methods=["GET"])
def get_boxes_by_date():
    """日时间线：返回指定日期（本地 YYYY-MM-DD）的所有时间盒"""
    date_str = request.args.get("date", "")
    if not date_str:
        # 默认今天（UTC+8 近似，用服务器本地时间）
        date_str = datetime.now().strftime("%Y-%m-%d")
    try:
        from datetime import timedelta
        day_start = datetime.strptime(date_str, "%Y-%m-%d")
        day_end = day_start + timedelta(days=1)
        start_ms = day_start.timestamp() * 1000
        end_ms = day_end.timestamp() * 1000
    except ValueError:
        return jsonify({"error": "invalid date"}), 400

    boxes = TimeBox.query.filter(
        TimeBox.opened_at >= start_ms,
        TimeBox.opened_at < end_ms,
    ).order_by(TimeBox.opened_at.asc()).all()

    result = []
    for b in boxes:
        d = b.to_dict()
        t = Task.query.get(b.task_id)
        d["taskName"] = t.name if t else "(已删除)"
        d["taskPriority"] = t.priority if t else "mid"
        result.append(d)
    return jsonify(result)


# ── Settings ──

@app.route("/api/settings", methods=["GET"])
def get_settings():
    state = AppState.query.get(1)
    return jsonify({
        "notifyEnabled": state.notify_enabled,
        "soundEnabled": state.sound_enabled,
        "filter": state.filter_key,
        "defaultBudgetSecs": state.default_budget_secs or 1500,
    })

@app.route("/api/settings", methods=["PUT"])
def set_settings():
    d = request.get_json(force=True)
    state = AppState.query.get(1)
    if "notifyEnabled" in d:
        state.notify_enabled = d["notifyEnabled"]
    if "soundEnabled" in d:
        state.sound_enabled = d["soundEnabled"]
    if "filter" in d:
        state.filter_key = d["filter"]
    if "defaultBudgetSecs" in d:
        try:
            dbs = float(d["defaultBudgetSecs"])
            state.default_budget_secs = max(1, dbs)
        except (TypeError, ValueError):
            return jsonify({"error": "defaultBudgetSecs must be a number"}), 400
    db.session.commit()
    return jsonify({
        "notifyEnabled": state.notify_enabled,
        "soundEnabled": state.sound_enabled,
        "filter": state.filter_key,
        "defaultBudgetSecs": state.default_budget_secs or 1500,
    })


# ── 旧 timer API — 只读适配层，供浮窗过渡 ──

@app.route("/api/timer", methods=["GET"])
def get_timer():
    box = _active_box()
    state = AppState.query.get(1)
    if not box:
        return jsonify({
            "currentId": None, "timerRunning": False,
            "remaining": state.default_budget_secs or 1500,
            "intervalSecs": state.default_budget_secs or 1500,
            "overtimeSecs": 0, "liveOvertimeSecs": 0,
            "notifyEnabled": state.notify_enabled,
            "soundEnabled": state.sound_enabled,
        })
    d = box.to_dict()
    t = Task.query.get(box.task_id)
    return jsonify({
        "currentId": box.task_id,
        "timerRunning": box.status == "running",
        "remaining": d["remainingSecs"],
        "intervalSecs": box.budget_secs,
        "overtimeSecs": d["liveOvertimeSecs"],
        "liveOvertimeSecs": d["liveOvertimeSecs"],
        "notifyEnabled": state.notify_enabled,
        "soundEnabled": state.sound_enabled,
        "activeBoxId": box.id,
        "taskName": t.name if t else "",
    })

@app.route("/api/timer", methods=["PUT"])
def set_timer():
    # 旧写接口保留但不操作 box，仅更新 settings 中的非计时字段
    d = request.get_json(force=True)
    state = AppState.query.get(1)
    if "intervalSecs" in d:
        state.default_budget_secs = d["intervalSecs"]
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/api/current", methods=["GET"])
def get_current():
    box = _active_box()
    return jsonify({"currentId": box.task_id if box else None})

@app.route("/api/current", methods=["PUT"])
def set_current():
    # 旧接口：不直接操作 box，仅返回当前状态
    box = _active_box()
    return jsonify({"currentId": box.task_id if box else None})


# ── 禁止浏览器缓存 HTML/JSON ──

@app.after_request
def add_cache_headers(response):
    if response.mimetype in ('text/html', 'application/json'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response


# ─── Main ───────────────────────────────────────────────────────────────────────

# 在模块加载时初始化数据库，兼容 gunicorn 等 WSGI 服务器
with app.app_context():
    init_db()

if __name__ == "__main__":
    print("工作管理器后端启动 → http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False)
