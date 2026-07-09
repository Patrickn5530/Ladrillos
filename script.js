// ═══════════════════════════════════════════════════════════
//  LADRILLOS — Canvas edition
//  Un único <canvas> para todo el render.
//  Sin divs, sin layout reflow, sin DOM por frame.
// ═══════════════════════════════════════════════════════════

const canvas     = document.getElementById("gameCanvas");
const ctx        = canvas.getContext("2d");
const hudOverlay = document.getElementById("hudOverlay");

// ── Ajustar canvas al área disponible ──────────────────────
function resizeCanvas() {
    canvas.width  = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
}
resizeCanvas();
window.addEventListener("resize", () => { resizeCanvas(); resetPositions(); });

// ── AUDIO POOL ─────────────────────────────────────────────
const POOL = 4;
const pools = {}, poolIdx = {};
["sndCollision","sndBounce","sndWall","sndGameOver"].forEach(id => {
    const el  = document.getElementById(id);
    const src = el && el.querySelector("source");
    if (!src) return;
    const url = src.getAttribute("src");
    pools[id] = Array.from({length: POOL}, () => {
        const a = document.createElement("audio");
        a.src = url; a.volume = 0.5; a.preload = "auto";
        document.body.appendChild(a); return a;
    });
    poolIdx[id] = 0;
});
function playSound(id) {
    const pool = pools[id]; if (!pool) return;
    const a = pool[poolIdx[id]];
    poolIdx[id] = (poolIdx[id] + 1) % POOL;
    a.currentTime = 0; a.play().catch(() => {});
}
function unlockAudio() {
    Object.values(pools).forEach(p => p.forEach(a => {
        a.play().catch(() => {}); a.pause(); a.currentTime = 0;
    }));
}
document.addEventListener("touchstart", unlockAudio, { once: true });
document.addEventListener("click",      unlockAudio, { once: true });

// ── CONSTANTES ─────────────────────────────────────────────
const BASE_SPEED       = 5;
const BASE_BRICK_SPEED = 0.06;   // velocidad cómoda — delta time escala el resto
const BALL_R    = 14;
const BRICK_W   = 45, BRICK_H = 20, BRICK_GAP = 5, BRICK_COLS = 8;
const ROW_H     = BRICK_H + BRICK_GAP;
const PADDLE_H  = 14;
const PADDLE_BOTTOM = 20;
const PU_R      = 13;
const PU_SPEED  = 5.5;
const AD_DURATION = 5;

const BRICK_COLORS = [
    "#ff4757","#ff6b81","#ffa502","#eccc68",
    "#2ed573","#7bed9f","#1e90ff","#70a1ff","#fd79a8","#00cec9"
];
const BG_PAIRS = [
    ["#0d1b2a","#415a77"], ["#1a0a2e","#553a94"],
    ["#0a1628","#1565c0"], ["#1a0000","#8b0000"],
    ["#0a1f0a","#2e7d32"], ["#0d0d0d","#0f3460"],
];
const rand = arr => arr[Math.floor(Math.random() * arr.length)];

const POWERS = {
    turbo:  { icon:"⚡", label:"Turbo",       color:"#ffa502", duration: 8000  },
    wide:   { icon:"↔️",  label:"Barra ancha", color:"#ff6b81", duration:10000  },
    double: { icon:"🔵", label:"Pelota x2",   color:"#70a1ff", duration: null  },
    shield: { icon:"🛡️", label:"Escudo",       color:"#00cec9", duration: null  },
};

// ── ESTADO ─────────────────────────────────────────────────
let score = 0, level = 1, brokenCount = 0;
let ballSpeed  = BASE_SPEED;
let brickSpeed = BASE_BRICK_SPEED;
let paddleX = 0, paddleW = 0, basePaddleW = 0;
let gameRunning = false;
let rafId = null, lastTime = null;
let isMovingLeft = false, isMovingRight = false;
let containerLeft = 0;

let balls         = [];   // { x, y, dx, dy, isMain }
let bricks        = [];   // { x, y, type, hits, color }
let fallingPowers = [];   // { x, y, type }
let activePowers  = {};
let shieldCount   = 0;
let wideActive    = false;
let effects       = [];   // partículas de explosión
let bgColors      = BG_PAIRS[0];
let levelBannerTimer = 0;
let tutorialShown    = false;

// ── RANKING ARCADE (top 5) ─────────────────────────────────
// Cada entrada: { initials: "AAA", score: 0 }
function getRanking() {
    try {
        return JSON.parse(localStorage.getItem("ladrillosRanking") || "[]");
    } catch { return []; }
}
function saveRanking(ranking) {
    localStorage.setItem("ladrillosRanking", JSON.stringify(ranking));
}
// Devuelve true si el score entra en el top 5
function isTopScore(s) {
    const r = getRanking();
    return r.length < 5 || s > r[r.length - 1].score;
}
// Inserta y devuelve el ranking actualizado (máx 5)
function insertScore(initials, s) {
    const r = getRanking();
    r.push({ initials: initials.toUpperCase().slice(0, 3).padEnd(3, "A"), score: s });
    r.sort((a, b) => b.score - a.score);
    const updated = r.slice(0, 5);
    saveRanking(updated);
    return updated;
}
// Compatibilidad: el HUD sigue usando el #1 como "mejor puntaje"
function getBest() {
    const r = getRanking();
    return r.length > 0 ? r[0].score : 0;
}
function levelMult() { return 1 + (level - 1) * 0.15; }

function setSpeed(b, spd) {
    const mag = Math.hypot(b.dx, b.dy);
    if (mag < 0.001) { b.dx = 0; b.dy = -spd; return; }
    b.dx = (b.dx / mag) * spd;
    b.dy = (b.dy / mag) * spd;
}

function resetPositions() {
    basePaddleW = Math.min(Math.max(canvas.width * 0.28, 100), 220);
    paddleW     = wideActive
        ? Math.min(basePaddleW * 1.8, canvas.width * 0.58)
        : basePaddleW;
    paddleX = Math.min(paddleX || (canvas.width - paddleW) / 2, canvas.width - paddleW);
    containerLeft = canvas.getBoundingClientRect().left;
}

// ── LADRILLOS ───────────────────────────────────────────────
function chooseBrickType() {
    if (level < 2) return "normal";
    const r = Math.random();
    if (r < 0.10) return "golden";
    if (r < 0.18) return "tough";
    if (level >= 3 && r < 0.23) return "bomb";
    return "normal";
}

function addRow(topY) {
    const totalW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
    const startX = (canvas.width - totalW) / 2;
    for (let i = 0; i < BRICK_COLS; i++) {
        const type = chooseBrickType();
        const x    = startX + i * (BRICK_W + BRICK_GAP);
        const hits = type === "tough" ? 2 : 1;
        const color = type === "golden" ? "#f9ca24"
                    : type === "tough"  ? "#6c5ce7"
                    : type === "bomb"   ? "#2d3436"
                    : rand(BRICK_COLORS);
        bricks.push({ x, y: topY, type, hits, color });
    }
    lastRowDropped = 0;
}

let lastRowDropped = 0;

function initBricks() {
    bricks = [];
    for (let r = 0; r < 3; r++) addRow(-(3 - r) * ROW_H);
    lastRowDropped = 0;
}

function clearAllBricks() {
    bricks = []; fallingPowers = []; lastRowDropped = 0;
}

// ── PODERES ─────────────────────────────────────────────────
function dropPower(bx, by, type) {
    fallingPowers.push({ x: bx + BRICK_W / 2, y: by + BRICK_H / 2, type });
}

function activatePower(type, opts) {
    const def = POWERS[type];
    if (activePowers[type]) {
        clearTimeout(activePowers[type].timer);
        clearTimeout(activePowers[type].warnTimer);
        activePowers[type].badgeEl && activePowers[type].badgeEl.remove();
    }
    if (type === "turbo") {
        ballSpeed = BASE_SPEED * 1.45;
        balls.forEach(b => setSpeed(b, ballSpeed));
    } else if (type === "wide") {
        wideActive = true;
        paddleW = Math.min(basePaddleW * 1.8, canvas.width * 0.58);
        paddleX = Math.min(paddleX, canvas.width - paddleW);
    } else if (type === "shield") {
        shieldCount++;
        updateShieldHud();
        return; // sin timer
    } else if (type === "double") {
        const spawnX = opts && opts.x != null ? opts.x : (balls[0] ? balls[0].x : canvas.width / 2);
        const spawnY = opts && opts.y != null ? opts.y : (balls[0] ? balls[0].y : canvas.height / 2);
        spawnExtraBall(spawnX, spawnY);
        updateBallCountHud();
        return; // sin timer propio
    }

    const badgeEl = document.createElement("div");
    badgeEl.classList.add("power-badge");
    badgeEl.textContent = def.icon + " " + def.label;
    hudOverlay.appendChild(badgeEl);

    let warnTimer = null, timer = null;
    if (def.duration) {
        if (type === "wide") {
            warnTimer = setTimeout(() => {
                if (activePowers[type]) activePowers[type].warning = true;
            }, def.duration - 2500);
        }
        timer = setTimeout(() => deactivatePower(type), def.duration);
    }
    activePowers[type] = { timer, warnTimer, badgeEl, warning: false };
}

function deactivatePower(type) {
    if (!activePowers[type]) return;
    activePowers[type].badgeEl && activePowers[type].badgeEl.remove();
    delete activePowers[type];
    if (type === "turbo") {
        ballSpeed = BASE_SPEED * levelMult();
        balls.forEach(b => setSpeed(b, ballSpeed));
    } else if (type === "wide") {
        wideActive = false;
        paddleW = basePaddleW;
        paddleX = Math.min(paddleX, canvas.width - paddleW);
    }
}

function updateShieldHud() {
    let el = document.getElementById("shield-badge");
    if (shieldCount > 0) {
        if (!el) {
            el = document.createElement("div");
            el.classList.add("power-badge");
            el.id = "shield-badge";
            hudOverlay.appendChild(el);
        }
        el.textContent = "🛡️ ×" + shieldCount;
    } else {
        el && el.remove();
    }
}

function consumeShield() {
    shieldCount = Math.max(0, shieldCount - 1);
    updateShieldHud();
}

function clearAllPowers() {
    Object.keys(activePowers).forEach(t => {
        clearTimeout(activePowers[t].timer);
        clearTimeout(activePowers[t].warnTimer);
        activePowers[t].badgeEl && activePowers[t].badgeEl.remove();
    });
    activePowers = {};
    shieldCount = 0;
    wideActive  = false;
    const sb = document.getElementById("shield-badge");
    sb && sb.remove();
    const bb = document.getElementById("ball-count-badge");
    bb && bb.remove();
    hudOverlay.querySelectorAll(".power-badge").forEach(e => e.remove());
}

// ── SEGUNDA / EXTRA PELOTA ──────────────────────────────────
function spawnExtraBall(fromX, fromY) {
    // Ángulo aleatorio hacia arriba con ligera variación
    const angle = (Math.random() - 0.5) * (Math.PI / 2);
    const newBall = {
        x: fromX, y: fromY,
        dx: Math.sin(angle), dy: -Math.cos(angle),
        isMain: false,
    };
    setSpeed(newBall, ballSpeed);
    balls.push(newBall);
    updateBallCountHud();
}

function updateBallCountHud() {
    let el = document.getElementById("ball-count-badge");
    const extras = balls.filter(b => !b.isMain).length;
    if (extras > 0) {
        if (!el) {
            el = document.createElement("div");
            el.classList.add("power-badge");
            el.id = "ball-count-badge";
            hudOverlay.appendChild(el);
        }
        el.textContent = "🔵 ×" + (extras + 1);
    } else {
        el && el.remove();
    }
}

// ── EXPLOSIÓN BOMBA ─────────────────────────────────────────
function explodeBomb(bombIdx) {
    const bomb = bricks[bombIdx];
    // Efecto visual — partículas
    for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        effects.push({
            x: bomb.x + BRICK_W / 2, y: bomb.y + BRICK_H / 2,
            dx: Math.cos(angle) * (2 + Math.random() * 3),
            dy: Math.sin(angle) * (2 + Math.random() * 3),
            r: 4 + Math.random() * 4, life: 1, decay: 0.04,
            color: "#ffa502",
        });
    }
    // Destruir adyacentes
    const toDestroy = [];
    for (let i = bricks.length - 1; i >= 0; i--) {
        if (i === bombIdx) continue;
        const b = bricks[i];
        if (Math.abs(b.x - bomb.x) <= BRICK_W + BRICK_GAP + 1 &&
            Math.abs(b.y - bomb.y) <= BRICK_H + 2) {
            toDestroy.push(i);
        }
    }
    toDestroy.sort((a, b) => b - a);
    toDestroy.forEach(i => {
        score++; brokenCount++;
        bricks.splice(i, 1);
    });
}

// ── COLISIÓN PELOTA–LADRILLO ────────────────────────────────
function checkBrickCollision(b) {
    const turbo = !!activePowers["turbo"];
    let deflected = false;

    for (let i = bricks.length - 1; i >= 0; i--) {
        const br = bricks[i];
        if (b.x + BALL_R > br.x && b.x - BALL_R < br.x + BRICK_W &&
            b.y + BALL_R > br.y && b.y - BALL_R < br.y + BRICK_H) {

            // En modo turbo la pelota NO se desvía — perfora en línea recta
            if (!turbo && !deflected) {
                const overT  = (b.y + BALL_R) - br.y;
                const overBo = (br.y + BRICK_H) - (b.y - BALL_R);
                const overL  = (b.x + BALL_R) - br.x;
                const overR  = (br.x + BRICK_W) - (b.x - BALL_R);
                const minOv  = Math.min(overT, overBo, overL, overR);
                if (minOv === overL || minOv === overR) b.dx = -b.dx;
                else b.dy = -b.dy;
                setSpeed(b, ballSpeed);
                deflected = true; // solo un desvío por frame fuera de turbo
            }

            // En turbo el ladrillo duro se destruye de un golpe también
            const hitsToRemove = turbo ? br.hits : 1;
            br.hits -= hitsToRemove;

            if (br.hits <= 0) {
                const dropX = br.x, dropY = br.y, dropType = br.type;
                // Partículas
                for (let p = 0; p < (turbo ? 10 : 6); p++) {
                    const angle = Math.random() * Math.PI * 2;
                    effects.push({
                        x: br.x + BRICK_W/2, y: br.y + BRICK_H/2,
                        dx: Math.cos(angle) * (1 + Math.random() * (turbo ? 4 : 2)),
                        dy: Math.sin(angle) * (1 + Math.random() * (turbo ? 4 : 2)),
                        r: 3 + Math.random() * 3, life: 1, decay: 0.06,
                        color: br.color,
                    });
                }
                if (br.type === "bomb") explodeBomb(i);
                if (i < bricks.length && bricks[i] === br) bricks.splice(i, 1);

                playSound("sndCollision");
                score += dropType === "golden" ? 3 : dropType === "tough" ? 2 : 1;
                brokenCount++;
                checkLevelUp();

                const dropChance = dropType === "golden" ? 0.40
                                 : dropType === "normal"  ? 0.08 : 0;
                if (Math.random() < dropChance) {
                    dropPower(dropX, dropY, rand(Object.keys(POWERS)));
                }
            } else {
                br.color = "#b2bec3";
                playSound("sndCollision");
            }

            // Fuera de turbo: un ladrillo por frame
            if (!turbo) break;
        }
    }
}

// ── NIVELES ─────────────────────────────────────────────────
function checkLevelUp() {
    const newLevel = 1 + Math.floor(brokenCount / 30);
    if (newLevel > level) {
        level = newLevel;
        brickSpeed = BASE_BRICK_SPEED * (1 + (level - 1) * 0.12);
        if (!activePowers["turbo"]) {
            ballSpeed = BASE_SPEED * levelMult();
            balls.forEach(b => setSpeed(b, ballSpeed));
        }
        levelBannerTimer = 120; // frames ≈ 2s
    }
}

// ── ACTUALIZAR PELOTA ───────────────────────────────────────
function updateBall(b, delta) {
    b.x += b.dx * delta;
    b.y += b.dy * delta;

    const W    = canvas.width;
    const H    = canvas.height;
    const pTop = H - PADDLE_BOTTOM - PADDLE_H;

    // Paredes
    if (b.x - BALL_R <= 0) {
        b.x = BALL_R; b.dx = Math.abs(b.dx);
        setSpeed(b, ballSpeed); playSound("sndWall");
    } else if (b.x + BALL_R >= W) {
        b.x = W - BALL_R; b.dx = -Math.abs(b.dx);
        setSpeed(b, ballSpeed); playSound("sndWall");
    }
    if (b.y - BALL_R <= 0) {
        b.y = BALL_R; b.dy = Math.abs(b.dy);
        setSpeed(b, ballSpeed); playSound("sndWall");
    }

    // Barra
    if (b.dy > 0 &&
        b.y + BALL_R >= pTop &&
        b.y - BALL_R <  pTop + PADDLE_H &&
        b.x + BALL_R >  paddleX &&
        b.x - BALL_R <  paddleX + paddleW) {

        b.y = pTop - BALL_R;
        const norm  = (b.x - (paddleX + paddleW / 2)) / (paddleW / 2);
        const angle = Math.max(-0.92, Math.min(0.92, norm)) * (Math.PI / 3);
        b.dx = Math.sin(angle);
        b.dy = -Math.cos(angle);
        setSpeed(b, ballSpeed);
        playSound("sndBounce");
    }

    // Suelo
    if (b.y - BALL_R >= H) {
        if (b.isMain) {
            if (shieldCount > 0) {
                b.y  = pTop - BALL_R;
                b.dy = -Math.abs(b.dy);
                setSpeed(b, ballSpeed);
                consumeShield();
            } else {
                // Buscar una pelota secundaria para promover
                const nextMain = balls.find(x => x !== b && !x.isMain);
                if (nextMain) {
                    nextMain.isMain = true;   // promover
                    balls = balls.filter(x => x !== b); // quitar la principal caída
                    updateBallCountHud();
                } else {
                    // No quedan pelotas — game over
                    endGame(); return;
                }
            }
        } else {
            balls = balls.filter(x => x !== b);
            updateBallCountHud();
            // Si ya no quedan secundarias pero sigue la principal, ok
            return;
        }
    }

    checkBrickCollision(b);
}

// ── ACTUALIZAR LADRILLOS ────────────────────────────────────
function updateBricks(delta) {
    const maxY = canvas.height - 40;
    let hitBottom = false;
    bricks.forEach(br => {
        br.y += brickSpeed * delta;
        if (br.y + BRICK_H >= maxY) hitBottom = true;
    });
    if (hitBottom) {
        if (shieldCount > 0) {
            bricks = bricks.filter(br => {
                if (br.y + BRICK_H >= maxY) { return false; }
                return true;
            });
            consumeShield();
        } else {
            endGame(); return;
        }
    }
    lastRowDropped += brickSpeed * delta;
    if (lastRowDropped >= ROW_H) addRow(-BRICK_H);
}

// ── ACTUALIZAR PODERES CAYENDO ──────────────────────────────
function updatePowers(delta) {
    const pTop = canvas.height - PADDLE_BOTTOM - PADDLE_H;
    for (let i = fallingPowers.length - 1; i >= 0; i--) {
        const p = fallingPowers[i];
        p.y += PU_SPEED * delta;

        // Colisión con barra
        let hit = (p.y + PU_R >= pTop && p.y - PU_R <= pTop + PADDLE_H &&
                   p.x + PU_R >  paddleX && p.x - PU_R < paddleX + paddleW);

        // Colisión con cualquier pelota
        if (!hit) {
            for (const b of balls) {
                if (Math.hypot(p.x - b.x, p.y - b.y) < PU_R + BALL_R) {
                    hit = true; break;
                }
            }
        }

        if (hit) {
            activatePower(p.type, { x: p.x, y: p.y });
            fallingPowers.splice(i, 1);
        } else if (p.y - PU_R > canvas.height) {
            fallingPowers.splice(i, 1);
        }
    }
}

// ── EFECTOS ─────────────────────────────────────────────────
function updateEffects(delta) {
    for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        e.x += e.dx * delta; e.y += e.dy * delta;
        e.life -= e.decay * delta;
        e.r  *= 0.97;
        if (e.life <= 0) effects.splice(i, 1);
    }
}

// ── DIBUJO ──────────────────────────────────────────────────
function drawBackground() {
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, bgColors[0]);
    grad.addColorStop(1, bgColors[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Estrellas estáticas (semilla fija para no redibujarlas con Random)
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    const starCount = 40;
    for (let i = 0; i < starCount; i++) {
        // Posición pseudoaleatoria pero determinista
        const sx = ((i * 173 + 57) % canvas.width);
        const sy = ((i * 251 + 31) % (canvas.height * 0.75));
        const sr = (i % 3 === 0) ? 1.5 : 1;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawBricks() {
    bricks.forEach(br => {
        ctx.save();
        // Sombra
        ctx.shadowColor = "rgba(0,0,0,0.4)";
        ctx.shadowBlur  = 4;
        ctx.shadowOffsetY = 2;

        // Cuerpo
        ctx.fillStyle = br.color;
        roundRect(ctx, br.x, br.y, BRICK_W, BRICK_H, 4);
        ctx.fill();

        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Borde superior claro
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Icono de tipo especial
        const icon = br.type === "golden" ? "⭐"
                   : br.type === "bomb"   ? "💣"
                   : (br.type === "tough" && br.hits === 2) ? "🟣"
                   : (br.type === "tough" && br.hits === 1) ? "💫"
                   : null;
        if (icon) {
            ctx.font = "12px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(icon, br.x + BRICK_W / 2, br.y + BRICK_H / 2);
        }
        ctx.restore();
    });
}

function drawPaddle() {
    const py = canvas.height - PADDLE_BOTTOM - PADDLE_H;
    ctx.save();

    // Parpadeo si barra ancha está por expirar
    if (activePowers["wide"] && activePowers["wide"].warning) {
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(Date.now() / 120);
    }

    const grad = ctx.createLinearGradient(paddleX, py, paddleX, py + PADDLE_H);
    if (wideActive) {
        grad.addColorStop(0, "#ffe0e0");
        grad.addColorStop(1, "#b73a3a");
        ctx.shadowColor = "rgba(255,100,100,0.8)";
    } else {
        grad.addColorStop(0, "#e0e0ff");
        grad.addColorStop(1, "#3a4db7");
        ctx.shadowColor = "rgba(100,140,255,0.8)";
    }
    ctx.shadowBlur = 12;
    ctx.fillStyle  = grad;
    roundRect(ctx, paddleX, py, paddleW, PADDLE_H, 7);
    ctx.fill();

    // Brillo superior
    ctx.shadowBlur   = 0;
    ctx.globalAlpha  = 0.4;
    ctx.fillStyle    = "rgba(255,255,255,0.5)";
    roundRect(ctx, paddleX + 4, py + 2, paddleW - 8, PADDLE_H / 2 - 2, 4);
    ctx.fill();
    ctx.restore();
}

function drawBalls() {
    const turbo = !!activePowers["turbo"];
    balls.forEach((b, idx) => {
        ctx.save();
        if (turbo && b.isMain) {
            // Glow naranja pulsante en turbo
            const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 80);
            ctx.shadowColor = "#ffa502";
            ctx.shadowBlur  = 24 * pulse;
        } else {
            ctx.shadowColor = idx === 0 ? "rgba(255,255,255,0.5)" : "rgba(100,180,255,0.6)";
            ctx.shadowBlur  = 8;
        }
        ctx.font         = `${BALL_R * 2}px Arial`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        // Pelota principal en turbo → 🔥, secundarias → 🔵, normal → ⚽
        const emoji = (turbo && b.isMain) ? "🔥" : b.isMain ? "⚽" : "🔵";
        ctx.fillText(emoji, b.x, b.y);
        ctx.restore();
    });
}

function drawPowers() {
    fallingPowers.forEach(p => {
        ctx.save();
        const col = POWERS[p.type].color;
        ctx.shadowColor = col; ctx.shadowBlur = 12;
        ctx.fillStyle   = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PU_R, 0, Math.PI * 2);
        ctx.fill();

        // Borde blanco
        ctx.shadowBlur   = 0;
        ctx.strokeStyle  = "rgba(255,255,255,0.5)";
        ctx.lineWidth    = 1.5;
        ctx.stroke();

        // Icono
        ctx.font          = `${PU_R * 1.1}px Arial`;
        ctx.textAlign     = "center";
        ctx.textBaseline  = "middle";
        ctx.fillStyle     = "#fff";
        ctx.shadowBlur    = 0;
        ctx.fillText(POWERS[p.type].icon, p.x, p.y);
        ctx.restore();
    });
}

function drawShield() {
    if (shieldCount <= 0) return;
    const sy = canvas.height - PADDLE_BOTTOM - PADDLE_H - 4;
    const grad = ctx.createLinearGradient(0, sy, canvas.width, sy);
    grad.addColorStop(0,   "transparent");
    grad.addColorStop(0.3, "#00cec9");
    grad.addColorStop(0.7, "#55efc4");
    grad.addColorStop(1,   "transparent");
    ctx.save();
    ctx.shadowColor = "#00cec9"; ctx.shadowBlur = 10;
    ctx.strokeStyle = grad;
    ctx.lineWidth   = 3;
    ctx.beginPath();
    ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy);
    ctx.stroke();
    // Contador
    ctx.shadowBlur    = 0;
    ctx.font          = "bold 12px Arial";
    ctx.fillStyle     = "#00cec9";
    ctx.textAlign     = "right";
    ctx.textBaseline  = "bottom";
    ctx.fillText("🛡️×" + shieldCount, canvas.width - 8, sy - 2);
    ctx.restore();
}

function drawEffects() {
    effects.forEach(e => {
        ctx.save();
        ctx.globalAlpha = e.life;
        ctx.fillStyle   = e.color;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });
}

function drawHUD() {
    const fsize = Math.max(12, Math.min(canvas.width / 28, 18));
    const pad   = 8;

    // Fondo semitransparente para los boxes
    function hudBox(text, x, y, align) {
        ctx.save();
        ctx.font    = `bold ${fsize}px Arial`;
        ctx.textBaseline = "top";
        ctx.textAlign    = align;
        const tw = ctx.measureText(text).width;
        const bx = align === "left"  ? x - pad       : x - tw - pad;
        const bw = tw + pad * 2;
        ctx.fillStyle    = "rgba(0,0,0,0.4)";
        roundRect(ctx, bx, y - 2, bw, fsize + 8, 10);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(text, x, y + 2);
        ctx.restore();
    }

    hudBox(`🏆 ${getBest()}`,    10,              10, "left");
    hudBox(`Nivel ${level}`,      canvas.width/2,  10, "right");
    hudBox(`⭐ ${score}`,         canvas.width-10, 10, "right");

    // Banner de nivel
    if (levelBannerTimer > 0) {
        const alpha = Math.min(1, levelBannerTimer / 20);
        ctx.save();
        ctx.globalAlpha  = alpha;
        ctx.font         = `bold ${fsize * 2}px Arial`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle    = "rgba(0,0,0,0.6)";
        const bw = 200, bh = 52;
        roundRect(ctx, canvas.width/2 - bw/2, canvas.height/2 - bh/2, bw, bh, 14);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(`⬆️ Nivel ${level}`, canvas.width/2, canvas.height/2);
        ctx.restore();
    }

    // Pantalla de inicio con ranking arcade
    if (!gameRunning) {
        ctx.fillStyle = "rgba(0,0,0,0.62)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const cx = canvas.width / 2;
        const cy = canvas.height / 2;

        // Título
        ctx.save();
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.font         = `bold ${fsize * 2}px Arial`;
        ctx.fillStyle    = "#fff";
        ctx.shadowColor  = "#a29bfe"; ctx.shadowBlur = 14;
        ctx.fillText("🧱 Ladrillos", cx, cy - 110);
        ctx.restore();

        // Tabla ranking
        const ranking = getRanking();
        const rowH    = fsize + 10;
        const tableH  = 10 + rowH * (ranking.length > 0 ? ranking.length + 1 : 2) + 10;
        const tableW  = Math.min(240, canvas.width * 0.72);
        const tableX  = cx - tableW / 2;
        const tableY  = cy - 60;

        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        roundRect(ctx, tableX, tableY, tableW, tableH, 12);
        ctx.fill();
        ctx.strokeStyle = "rgba(162,155,254,0.4)";
        ctx.lineWidth   = 1;
        ctx.stroke();

        // Cabecera
        ctx.font         = `bold ${fsize * 0.85}px Arial`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle    = "#a29bfe";
        ctx.fillText("🏆  MEJORES PUNTAJES", cx, tableY + 10);

        if (ranking.length === 0) {
            ctx.font      = `${fsize * 0.8}px Arial`;
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.fillText("¡Sé el primero!", cx, tableY + 10 + rowH + 4);
        } else {
            const medals = ["🥇","🥈","🥉","④","⑤"];
            ranking.forEach((entry, i) => {
                const ry = tableY + 10 + rowH * (i + 1) + 4;
                ctx.font      = `bold ${fsize * 0.85}px Arial`;
                ctx.fillStyle = i === 0 ? "#ffd700" : i === 1 ? "#c0c0c0" : i === 2 ? "#cd7f32" : "rgba(255,255,255,0.6)";
                ctx.textAlign = "left";
                ctx.fillText(`${medals[i]} ${entry.initials}`, tableX + 14, ry);
                ctx.textAlign = "right";
                ctx.fillText(String(entry.score).padStart(6, " "), tableX + tableW - 14, ry);
            });
        }
        ctx.restore();

        // "Toca para iniciar"
        const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 500);
        ctx.save();
        ctx.globalAlpha  = pulse;
        ctx.font         = `${fsize * 1.05}px Arial`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle    = "#fff";
        ctx.fillText("Toca para iniciar", cx, tableY + tableH + 28);
        ctx.restore();
    }
}

// ── RECTÁNGULO REDONDEADO ───────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ── GAME LOOP ───────────────────────────────────────────────
function gameLoop(ts) {
    const delta = lastTime === null ? 1
        : Math.min((ts - lastTime) / (1000 / 60), 2.5);
    lastTime = ts;

    if (gameRunning) {
        [...balls].forEach(b => updateBall(b, delta));
        if (gameRunning) updateBricks(delta);
        if (gameRunning) updatePowers(delta);
        updateEffects(delta);
        if (levelBannerTimer > 0) levelBannerTimer -= delta;
        // Teclado
        if (isMovingLeft)  paddleX = Math.max(0, paddleX - 9 * delta);
        if (isMovingRight) paddleX = Math.min(canvas.width - paddleW, paddleX + 9 * delta);
    }

    // Render siempre (para mostrar pantalla de inicio también)
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackground();
    drawEffects();
    drawBricks();
    drawShield();
    drawPaddle();
    drawBalls();
    drawPowers();
    drawHUD();

    rafId = requestAnimationFrame(gameLoop);
}

// ── INPUT ───────────────────────────────────────────────────
canvas.addEventListener("mousemove", e => {
    if (!gameRunning) return;
    paddleX = Math.max(0, Math.min(e.clientX - containerLeft - paddleW / 2, canvas.width - paddleW));
});
canvas.addEventListener("touchmove", e => {
    e.preventDefault();
    paddleX = Math.max(0, Math.min(e.touches[0].clientX - containerLeft - paddleW / 2, canvas.width - paddleW));
}, { passive: false });
canvas.addEventListener("touchstart", e => {
    e.preventDefault();
    paddleX = Math.max(0, Math.min(e.touches[0].clientX - containerLeft - paddleW / 2, canvas.width - paddleW));
    if (!gameRunning) startGame();
}, { passive: false });
document.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft")  { isMovingLeft  = true; e.preventDefault(); }
    if (e.key === "ArrowRight") { isMovingRight = true; e.preventDefault(); }
    if (e.key === "Enter" && !gameRunning) startGame();
});
document.addEventListener("keyup", e => {
    if (e.key === "ArrowLeft")  isMovingLeft  = false;
    if (e.key === "ArrowRight") isMovingRight = false;
});
canvas.addEventListener("click", () => { if (!gameRunning) startGame(); });

// ── ANUNCIO INTERSTICIAL ────────────────────────────────────
function showInterstitialAd() {
    return new Promise(resolve => {
        const ov = document.createElement("div");
        ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.93);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:Arial,sans-serif;";
        ov.innerHTML = `
            <div style="color:rgba(255,255,255,.3);font-size:11px;letter-spacing:.15em;text-transform:uppercase">Anuncio</div>
            <div style="width:min(320px,85vw);height:min(250px,45vw);background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid rgba(255,255,255,.08);border-radius:12px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.2);font-size:13px;letter-spacing:.05em">
                <!-- Código AdSense aquí -->
                Espacio publicitario
            </div>
            <div style="display:flex;align-items:center;gap:10px">
                <span style="color:rgba(255,255,255,.4);font-size:13px">Cierra en <b id="adCnt">${AD_DURATION}</b>s</span>
                <button id="adSkip" disabled style="padding:8px 20px;border-radius:20px;border:none;background:rgba(255,255,255,.1);color:rgba(255,255,255,.3);font-size:13px;cursor:not-allowed;transition:all .3s">Saltar ✕</button>
            </div>`;
        document.body.appendChild(ov);
        const btn = ov.querySelector("#adSkip");
        const cnt = ov.querySelector("#adCnt");
        let rem = AD_DURATION;
        const tick = setInterval(() => {
            cnt.textContent = --rem;
            if (rem <= 0) {
                clearInterval(tick);
                btn.disabled = false;
                btn.style.cssText += "background:rgba(255,255,255,.85);color:#111;cursor:pointer;";
            }
        }, 1000);
        btn.addEventListener("click", () => {
            if (btn.disabled) return;
            clearInterval(tick); ov.remove(); resolve();
        });
    });
}

// ── TUTORIAL ────────────────────────────────────────────────
function showTutorial() {
    return Swal.fire({
        title: "🎮 ¡Bienvenido a Ladrillos!",
        html: `<div style="text-align:left;line-height:1.75;font-size:clamp(12px,3vw,14px)">
            <b style="color:#a29bfe">🎯 Objetivo</b><br>
            Mueve la barra para que la pelota ⚽ rebote y rompa los ladrillos.<br>
            ¡No dejes que lleguen al suelo!<br><br>
            <b style="color:#a29bfe">🧱 Tipos de ladrillo</b><br>
            ⭐ <b>Dorado</b> — 3 pts, puede soltar un premio<br>
            🟣 <b>Duro</b> — necesita 2 golpes<br>
            💣 <b>Bomba</b> — destruye los de al lado<br><br>
            <b style="color:#a29bfe">🎁 Premios (atrapa con la barra o la pelota)</b><br>
            ⚡ Turbo · ↔️ Barra ancha · 🔵 Pelota doble · 🛡️ Escudo (acumulable)<br><br>
            <b style="color:#a29bfe">⬆️ Dificultad</b><br>
            Cada 20 ladrillos rotos sube el nivel.
        </div>`,
        confirmButtonText: "¡A jugar! 🚀",
        customClass: { popup: "swal-popup" },
    });
}

// ── INICIO / FIN ────────────────────────────────────────────
function launchGame() {
    bgColors    = rand(BG_PAIRS);
    score       = 0; level = 1; brokenCount = 0;
    ballSpeed   = BASE_SPEED; brickSpeed = BASE_BRICK_SPEED;
    effects     = []; levelBannerTimer = 0;
    lastTime    = null;
    wideActive  = false;
    shieldCount = 0;
    clearAllPowers();
    resetPositions();
    initBricks();

    const startY = canvas.height - PADDLE_BOTTOM - PADDLE_H - BALL_R - 4;
    balls = [{ x: canvas.width / 2, y: startY,
               dx: BASE_SPEED * 0.6, dy: -BASE_SPEED * 0.8, isMain: true }];
    setSpeed(balls[0], BASE_SPEED);
    gameRunning = true;
}

function startGame() {
    if (gameRunning) return;
    if (!tutorialShown) {
        tutorialShown = true;
        showInterstitialAd()
            .then(() => showTutorial())
            .then(() => launchGame());
    } else {
        launchGame();
    }
}

function endGame() {
    if (!gameRunning) return;
    gameRunning = false;
    lastTime    = null;
    clearAllBricks();
    clearAllPowers();
    playSound("sndGameOver");

    const qualified = isTopScore(score);

    // Paso 1: mostrar resultado
    Swal.fire({
        iconHtml: '<div style="font-size:1.8em">⚽</div>',
        title: "💥 Fin del juego",
        html: `Nivel: <b>${level}</b> &nbsp;|&nbsp; Puntaje: <b>${score}</b><br>
               Ladrillos rotos: <b>${brokenCount}</b><br>
               ${qualified ? '<br>🏆 <b style="color:#ffd700">¡Entraste al top 5!</b>' : ""}`,
        confirmButtonText: qualified ? "Guardar puntaje ▶" : "Ver anuncio y continuar ▶",
        customClass: { popup: "swal-popup" },
    }).then(() => {
        if (qualified) {
            // Paso 2: pedir iniciales estilo arcade
            Swal.fire({
                title: "🏆 Ingresa tus iniciales",
                html: `<div style="text-align:center;margin-top:8px">
                    <input id="initialsInput" maxlength="3"
                        style="width:100px;font-size:2em;text-align:center;text-transform:uppercase;
                               background:#0d1b2a;color:#fff;border:2px solid #a29bfe;
                               border-radius:8px;padding:6px;letter-spacing:.2em;"
                        placeholder="AAA">
                    </div>`,
                confirmButtonText: "Guardar ✓",
                customClass: { popup: "swal-popup" },
                preConfirm: () => {
                    const val = document.getElementById("initialsInput").value.trim().toUpperCase();
                    if (!val) return "AAA";
                    return val.padEnd(3, "A").slice(0, 3);
                },
                didOpen: () => {
                    const inp = document.getElementById("initialsInput");
                    inp.focus();
                    inp.addEventListener("input", () => {
                        inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, "");
                    });
                },
            }).then(result => {
                const initials = result.value || "AAA";
                const ranking  = insertScore(initials, score);

                // Paso 3: mostrar ranking actualizado
                const medals = ["🥇","🥈","🥉","④","⑤"];
                const rows = ranking.map((e, i) =>
                    `<tr style="color:${i===0?"#ffd700":i===1?"#c0c0c0":i===2?"#cd7f32":"rgba(255,255,255,.7)"}">
                        <td style="padding:4px 10px;text-align:left">${medals[i]} ${e.initials}</td>
                        <td style="padding:4px 10px;text-align:right;font-weight:bold">${e.score}</td>
                    </tr>`
                ).join("");

                Swal.fire({
                    title: "🏆 Mejores puntajes",
                    html: `<table style="width:100%;border-collapse:collapse;font-size:1.1em">${rows}</table>`,
                    confirmButtonText: "Ver anuncio y continuar ▶",
                    customClass: { popup: "swal-popup" },
                }).then(() => showInterstitialAd().then(() => {
                    balls = []; resetPositions();
                }));
            });
        } else {
            showInterstitialAd().then(() => {
                balls = []; resetPositions();
            });
        }
    });
}

// ── ARRANQUE ────────────────────────────────────────────────
resetPositions();
requestAnimationFrame(gameLoop);
