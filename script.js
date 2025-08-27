const LOGICAL_W = 900, LOGICAL_H = 620;
const canvas = document.getElementById('game'), ctx = canvas.getContext('2d');
let scale = 1;
function resize(){ // fit canvas to display while preserving logical coordinate scale
  const parent = canvas.parentElement;
  const w = parent.clientWidth;
  const h = window.innerHeight - parent.getBoundingClientRect().top - 80;
  const cssW = Math.min(w, LOGICAL_W);
  canvas.style.width = cssW + 'px';
  canvas.style.height = Math.min(cssW * (LOGICAL_H / LOGICAL_W), cssW * (LOGICAL_H / LOGICAL_W)) + 'px';
  const rect = canvas.getBoundingClientRect();
  scale = rect.width / LOGICAL_W;
  canvas.width = Math.floor(LOGICAL_W * scale);
  canvas.height = Math.floor(LOGICAL_H * scale);
  ctx.setTransform(scale,0,0,scale,0,0);
}
window.addEventListener('resize', resize);
/* --------- UI refs --------- */
const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');
const levelEl = document.getElementById('level');
const highEl = document.getElementById('highscore');
const shieldDisplay = document.getElementById('shieldDisplay');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const restartBtn = document.getElementById('restartBtn');

/* --------- AUDIO (tiny) --------- */
const enableSound = true;
function playBeep(frequency=440, time=0.05, type='sine'){
  if(!enableSound) return;
  try{
    const a = new (window.AudioContext || window.webkitAudioContext)();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.value = frequency;
    o.connect(g); g.connect(a.destination);
    g.gain.value = 0.02;
    o.start();
    o.stop(a.currentTime + time);
    setTimeout(()=>{ a.close(); }, (time+0.05)*1000);
  } catch(e){}
}

/* --------- GAME STATE --------- */
let game = null;
const STORAGE_KEY = 'adv_brick_highscore';
let highScore = parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10);

/* --------- UTIL --------- */
function rand(min, max){ return Math.random()*(max-min)+min; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function now(){ return performance.now(); }

/* --------- ENTITIES & FACTORIES --------- */
function makeGame(){
  return {
    running:false,
    paused:false,
    score:0,
    lives:3,
    shields:0,
    level:1,
    balls:[],
    paddle:{w:140,h:14,x:(LOGICAL_W-140)/2,y:LOGICAL_H-70, speed:640, expandUntil:0, laserCooldown:0},
    bricks:[],
    powerups:[],
    lasers:[],
    particles:[],
    boss:null,
    lastBallLaunch:0,
    time:0
  };
}

/* Ball factory */
function addBall(g, x, y, dx, dy, speed){
  speed = speed || (220 + (g.level-1)*20);
  dx = dx || rand(-0.7,0.7);
  dy = dy || -Math.abs(rand(0.35,0.8));
  const b = {x,y,r:8,dx,dy,speed,owner:'player'};
  g.balls.push(b);
  return b;
}

/* Brick layout generator per level */
function initLevel(g){
  g.bricks = [];
  g.powerups = [];
  g.lasers = [];
  g.particles = [];
  g.boss = null;

  // for boss level (every 6th), create boss
  if(g.level % 6 === 0){
    g.boss = {
      x: LOGICAL_W/2 - 140, y: 80, w: 280, h: 60,
      hp: 30 + g.level*5, maxHp: 30 + g.level*5, dir: 1, speed: 60 + g.level*6, lastShot: 0
    };
   
    for(let r=0;r<3;r++){
      for(let c=0;c<10;c++){
        const w = 72, h = 22;
        const x = 50 + c*(w+6);
        const y = 180 + r*(h+6);
        g.bricks.push({x,y,w,h,alive:true,hits:1,type: (Math.random()<0.12?'power': 'normal')});
      }
    }
    return;
  }

  // normal levels: rows/cols grow slowly
  const rows = clamp(4 + Math.floor((g.level-1)/2), 4, 9);
  const cols = clamp(7 + Math.floor((g.level-1)/3), 7, 12);
  const brickW = Math.floor((LOGICAL_W - 80 - (cols-1)*8)/cols);
  const brickH = 20;
  const startX = 40;
  const startY = 90;

  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const x = startX + c*(brickW + 8);
      const y = startY + r*(brickH + 8);
      // brick strength varies with row and level
      let hits = 1 + Math.floor(r/2) + Math.floor((g.level-1)/5);
      // some bricks are special (power-up or sturdy)
      const roll = Math.random();
      const type = roll < 0.08 ? 'power' : (roll < 0.15 ? 'sturdy' : 'normal');
      if(type === 'sturdy') hits += 1;
      g.bricks.push({x,y,w:brickW,h:brickH,alive:true,hits,type});
    }
  }
}

/* Powerup factory */
const POWER_TYPES = ['expand','multiball','slow','laser','shield'];
function spawnPowerup(g, x, y){
  const t = POWER_TYPES[Math.floor(Math.random()*POWER_TYPES.length)];
  g.powerups.push({x,y,w:18,h:18,type:t,vy:60});
}

/* Particles */
function spawnParticles(g, x, y, color, count=14){
  for(let i=0;i<count;i++){
    g.particles.push({
      x,y,vx:rand(-200,200),vy:rand(-120,80),life: rand(0.4,1.1),age:0, color
    });
  }
}

/* --------- COLLISIONS --------- */
function circleRectCollide(circle, rect){
  const rx = rect.x, ry = rect.y, rw = rect.w || rect.width, rh = rect.h || rect.height;
  const cx = circle.x, cy = circle.y, r = circle.r;
  const nearestX = Math.max(rx, Math.min(cx, rx + rw));
  const nearestY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return (dx*dx + dy*dy) <= (r*r);
}

/* --------- GAME ACTIONS --------- */
function applyPowerup(g, type){
  playBeep(880,0.06);
  const p = g.paddle;
  switch(type){
    case 'expand':
      p.w = Math.min(260, p.w * 1.5);
      p.expandUntil = g.time + 12000;
      break;
    case 'multiball':
      // create two extra balls near current
      const existing = g.balls.slice(0, Math.min(2,g.balls.length));
      existing.forEach(b => addBall(g, b.x, b.y, rand(-0.8,0.8), -Math.abs(rand(0.4,0.9)), b.speed*1.0));
      break;
    case 'slow':
      // slow all balls temporarily
      g.balls.forEach(b => b._slowUntil = g.time + 9000);
      break;
    case 'laser':
      p._laserUntil = g.time + 12000;
      p.laserCooldown = 0;
      break;
    case 'shield':
      g.shields = Math.min(3, g.shields + 1);
      break;
  }
}

/* --------- UPDATE LOOP --------- */
let last = 0;
function startGame(){
  game = makeGame();
  game.running = true;
  game.paused = false;
  game.level = 1;
  initLevel(game);
  addBall(game, LOGICAL_W/2, LOGICAL_H-100, rand(-0.5,0.5), -0.7);
  updateUI();
  last = now();
  requestAnimationFrame(loop);
}

function restartGame(){
  startGame();
}

function updateUI(){
  scoreEl.textContent = Math.floor(game.score);
  livesEl.textContent = game.lives;
  levelEl.textContent = game.level;
  highEl.textContent = highScore;
  shieldDisplay.innerHTML = game.shields ? ' <span style="color:#7dd3fc">♦'.repeat(game.shields) + '</span>' : '';
}

/* Input */
const keys = {left:false,right:false,shoot:false};
window.addEventListener('keydown', e=>{
  if(e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
  if(e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
  if(e.code === 'Space'){ if(game) { game.paused = !game.paused; updateUI(); } }
  if(e.key === 'r' || e.key === 'R') restartGame();
});
window.addEventListener('keyup', e=>{
  if(e.key === 'ArrowLeft' || e.key === 'a') keys.left = false;
  if(e.key === 'ArrowRight' || e.key === 'd') keys.right = false;
});

/* Mouse / touch */
let pointerDown = false;
canvas.addEventListener('mousedown', e=>{ pointerDown = true; fireLaser(); movePaddleTo(e); });
canvas.addEventListener('mouseup', ()=> pointerDown = false);
canvas.addEventListener('mousemove', e=> movePaddleTo(e));
canvas.addEventListener('touchstart', e=>{ pointerDown = true; movePaddleTo(e.touches[0]); fireLaser(); e.preventDefault(); }, {passive:false});
canvas.addEventListener('touchmove', e=>{ movePaddleTo(e.touches[0]); e.preventDefault(); }, {passive:false});
canvas.addEventListener('touchend', e=>{ pointerDown = false; e.preventDefault(); }, {passive:false});

function movePaddleTo(e){
  if(!game) return;
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left)/scale;
  game.paddle.x = px - game.paddle.w/2;
  clampPaddle();
}

function clampPaddle(){ if(!game) return; game.paddle.x = clamp(game.paddle.x, 0, LOGICAL_W - game.paddle.w); }

/* Laser shooting */
function fireLaser(){
  if(!game) return;
  const p = game.paddle;
  if(!(p._laserUntil && p._laserUntil > game.time)) return; // only if powered
  if(p.laserCooldown && p.laserCooldown > game.time) return;
  // spawn lasers upwards from paddle
  const lx = p.x + p.w*0.22, rx = p.x + p.w*0.78;
  game.lasers.push({x: lx, y: p.y - 6, vy:-520});
  game.lasers.push({x: rx, y: p.y - 6, vy:-520});
  p.laserCooldown = game.time + 220; // ms
  playBeep(1200,0.04,'square');
}

/* Main loop */
function loop(t){
  if(!game) return;
  resize();
  const dt = Math.min(1/30, (t - last)/1000);
  last = t;
  if(game.running && !game.paused){
    game.time += dt*1000;
    stepGame(game, dt);
  }
  renderGame(game);
  requestAnimationFrame(loop);
}

/* Game step */
function stepGame(g, dt){
  // update paddle expiration
  if(g.paddle.expandUntil && g.time > g.paddle.expandUntil){ g.paddle.w = 140; g.paddle.expandUntil = 0; }
  // input
  if(keys.left) g.paddle.x -= g.paddle.speed * dt;
  if(keys.right) g.paddle.x += g.paddle.speed * dt;
  clampPaddle();

  // paddle laser cooldown check
  if(g.paddle.laserCooldown && g.time > g.paddle.laserCooldown) g.paddle.laserCooldown = 0;

  // balls
  for(let i = g.balls.length-1; i>=0; i--){
    const b = g.balls[i];
    // speed modifiers
    const effectiveSpeed = (b._slowUntil && g.time < b._slowUntil) ? b.speed * 0.55 : b.speed;
    b.x += b.dx * effectiveSpeed * dt;
    b.y += b.dy * effectiveSpeed * dt;

    // walls
    if(b.x - b.r <= 0){ b.x = b.r; b.dx *= -1; playBeep(400,0.02); }
    if(b.x + b.r >= LOGICAL_W){ b.x = LOGICAL_W - b.r; b.dx *= -1; playBeep(400,0.02); }
    if(b.y - b.r <= 0){ b.y = b.r; b.dy *= -1; playBeep(400,0.02); }

    // paddle collision
    if(circleRectCollide(b, g.paddle)){
      // calculate reflection based on hit point
      const p = g.paddle;
      const rel = (b.x - (p.x + p.w/2)) / (p.w/2); // -1..1
      const angle = rel * (Math.PI/3); // up to 60deg
      const speed = Math.hypot(b.dx, b.dy);
      b.dx = Math.sin(angle);
      b.dy = -Math.cos(angle);
      // small speed bump
      b.speed *= 1.01;
      b.y = p.y - b.r - 0.5;
      playBeep(1200,0.01);
    }

    // bricks collision
    for(const brick of g.bricks){
      if(!brick.alive) continue;
      if(circleRectCollide(b, brick)){
        // reflect properly by detecting side
        const overlapX = (b.x) - Math.max(brick.x, Math.min(b.x, brick.x + brick.w));
        const overlapY = (b.y) - Math.max(brick.y, Math.min(b.y, brick.y + brick.h));
        // if absolute X overlap > absolute Y overlap, flip dx else dy (simple)
        if(Math.abs(overlapX) > Math.abs(overlapY)) b.dx *= -1; else b.dy *= -1;
        // apply damage
        brick.hits -= 1;
        spawnParticles(g, b.x, b.y, 'rgba(255,220,150,0.9)', 8);
        if(brick.hits <= 0){
          brick.alive = false;
          g.score += 100;
          // drop powerup sometimes
          if(brick.type === 'power' || Math.random() < 0.06){
            spawnPowerup(g, brick.x + brick.w/2, brick.y + brick.h/2);
          } else if(brick.type === 'sturdy'){
            // sturdy yields more score
            g.score += 40;
          }
        } else {
          g.score += 30;
        }
        playBeep(700,0.02,'sine');
      }
    }

    // boss interactions (if present)
    if(g.boss && b.y < g.boss.y + g.boss.h && b.y > g.boss.y - 40 && b.x > g.boss.x && b.x < g.boss.x + g.boss.w){
      // hit boss
      g.boss.hp -= 1;
      b.dy *= -1;
      spawnParticles(g, b.x, b.y, 'rgba(255,120,120,0.95)', 12);
      g.score += 200;
      playBeep(150,0.03,'triangle');
      if(g.boss.hp <= 0){
        // boss defeated -> level up
        g.boss = null;
        g.score += 2000;
        nextLevel(g);
        return;
      }
    }

    // bottom - ball lost
    if(b.y - b.r > LOGICAL_H){
      g.balls.splice(i,1);
    }
  }

  // if no balls left: lose life
  if(g.balls.length === 0){
    if(g.shields > 0){
      g.shields -= 1;
      addBall(g, LOGICAL_W/2, LOGICAL_H-100, rand(-0.5,0.5), -0.7);
      playBeep(240,0.06);
    } else {
      g.lives -= 1;
      playBeep(180,0.08);
      if(g.lives <= 0){
        // game over
        g.running = false;
        checkHighscore(g.score);
        return;
      } else {
        addBall(g, LOGICAL_W/2, LOGICAL_H-100, rand(-0.5,0.5), -0.7);
      }
    }
  }

  // powerups falling
  for(let i = g.powerups.length-1; i>=0; i--){
    const pu = g.powerups[i];
    pu.y += pu.vy * dt;
    if(pu.y > LOGICAL_H + 30){ g.powerups.splice(i,1); continue; }
    // paddle catch
    if(pu.x > g.paddle.x && pu.x < g.paddle.x + g.paddle.w && pu.y > g.paddle.y - 6 && pu.y < g.paddle.y + g.paddle.h + 6){
      applyPowerup(g, pu.type);
      g.powerups.splice(i,1);
    }
  }

  // lasers update & hit bricks/boss
  for(let i=g.lasers.length-1;i>=0;i--){
    const L = g.lasers[i];
    L.y += L.vy * dt;
    // check collisions with bricks
    for(const brick of g.bricks){
      if(!brick.alive) continue;
      if(L.x >= brick.x && L.x <= brick.x + brick.w && L.y >= brick.y && L.y <= brick.y + brick.h){
        brick.hits -= 2; // laser strong
        spawnParticles(g, L.x, L.y, 'rgba(255,255,180,0.95)', 6);
        g.lasers.splice(i,1);
        if(brick.hits <= 0){ brick.alive = false; g.score += 120; if(Math.random() < 0.08) spawnPowerup(g, brick.x + brick.w/2, brick.y + brick.h/2); }
        break;
      }
    }
    if(!g.lasers[i]) continue;
    // boss
    if(g.boss && L.y > g.boss.y && L.y < g.boss.y + g.boss.h && L.x > g.boss.x && L.x < g.boss.x + g.boss.w){
      g.boss.hp -= 3;
      spawnParticles(g, L.x, L.y, 'rgba(255,80,80,1)', 8);
      g.lasers.splice(i,1);
      if(g.boss.hp <= 0){
        g.boss = null;
        g.score += 2000;
        nextLevel(g);
        return;
      }
    }
    if(L.y < -10) g.lasers.splice(i,1);
  }

  // particles aging
  for(let i=g.particles.length-1;i>=0;i--){
    const p = g.particles[i];
    p.age += dt;
    p.vy += 160 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if(p.age > p.life) g.particles.splice(i,1);
  }

  // boss AI
  if(g.boss){
    g.boss.x += g.boss.dir * g.boss.speed * dt;
    if(g.boss.x < 30){ g.boss.x = 30; g.boss.dir *= -1; }
    if(g.boss.x + g.boss.w > LOGICAL_W - 30){ g.boss.x = LOGICAL_W - 30 - g.boss.w; g.boss.dir *= -1; }
    // boss shoots sporadically
    if(g.time - g.boss.lastShot > 1400 - Math.min(900, g.level*15)){
      g.boss.lastShot = g.time;
      // shoot downward bricks/bullets
      const bx = g.boss.x + rand(40, g.boss.w-40);
      g.particles.push({x:bx, y:g.boss.y + g.boss.h, vx:0, vy:120, life:2, age:0, color:'rgba(255,140,80,0.9)', bullet:true});
    }
  }

  // particles used as bullets - check collisions with paddle
  for(let i=g.particles.length-1;i>=0;i--){
    const p = g.particles[i];
    if(p.bullet){
      p.y += p.vy * dt;
      if(p.y > LOGICAL_H) g.particles.splice(i,1);
      // hit paddle
      if(p.y > g.paddle.y && p.x > g.paddle.x && p.x < g.paddle.x + g.paddle.w){
        // deduct shield or life
        if(g.shields > 0) g.shields -= 1; else { g.lives -= 1; if(g.lives <= 0){ g.running = false; checkHighscore(g.score); } }
        g.particles.splice(i,1);
        playBeep(200,0.06);
      }
    }
  }

  // check level cleared (no alive bricks and no boss)
  const anyAlive = g.bricks.some(b=>b.alive);
  if(!anyAlive && !g.boss){
    // level cleared
    nextLevel(g);
  }

  updateUI();
}

function nextLevel(g){
  g.level += 1;
  initLevel(g);
  // restore a ball
  g.balls = [];
  addBall(g, LOGICAL_W/2, LOGICAL_H-100, rand(-0.5,0.5), -0.7);
  // small reward
  g.lives = Math.min(5, g.lives + 0);
  playBeep(900,0.12,'sine');
  updateUI();
}

/* --------- RENDER --------- */
function renderGame(g){
  // background
  ctx.clearRect(0,0,LOGICAL_W,LOGICAL_H);
  const bg = ctx.createLinearGradient(0,0,0,LOGICAL_H);
  bg.addColorStop(0, '#021526'); bg.addColorStop(1, '#031b2b');
  ctx.fillStyle = bg; ctx.fillRect(0,0,LOGICAL_W,LOGICAL_H);

  // bricks
  for(const b of g.bricks){
    if(!b.alive) continue;
    // color based on type/hits
    let fill = '#60a5fa';
    if(b.type === 'sturdy') fill = '#f97316';
    if(b.type === 'power') fill = '#34d399';
    // darker for higher hits
    const shade = 1 - Math.min(0.6, (b.hits-1)*0.18);
    ctx.fillStyle = shadeColor(fill, shade);
    roundRect(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.fill();
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(b.x+2, b.y+2, b.w-4, b.h*0.22);
  }

  // paddle
  const p = g.paddle;
  ctx.save();
  const padGrad = ctx.createLinearGradient(p.x, p.y, p.x + p.w, p.y);
  padGrad.addColorStop(0, '#7dd3fc'); padGrad.addColorStop(1, '#60a5fa');
  ctx.fillStyle = padGrad;
  roundRect(ctx, p.x, p.y, p.w, p.h, 8);
  ctx.fill();
  // laser indicator
  if(p._laserUntil && p._laserUntil > g.time){
    ctx.fillStyle = 'rgba(255,255,200,0.06)';
    ctx.fillRect(p.x, p.y - 6, p.w, 4);
  }
  ctx.restore();

  // balls
  for(const b of g.balls){
    ctx.beginPath();
    ctx.fillStyle = '#fff';
    ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
    ctx.fill();
    ctx.closePath();
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.arc(b.x-2, b.y-2, Math.max(1,b.r*0.45), 0, Math.PI*2); ctx.fill();
  }

  // lasers
  ctx.strokeStyle = '#ffd86b'; ctx.lineWidth = 3;
  for(const L of g.lasers){
    ctx.beginPath();
    ctx.moveTo(L.x, L.y); ctx.lineTo(L.x, L.y - 18); ctx.stroke();
  }

  // powerups
  for(const pu of g.powerups){
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = pickPowerColor(pu.type);
    ctx.arc(pu.x, pu.y, 10, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(pu.x-6, pu.y-3, 12, 6);
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(pu.type[0].toUpperCase(), pu.x, pu.y + 3);
  }

  // particles
  for(const p of g.particles){
    ctx.fillStyle = p.color || 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI*2); ctx.fill();
  }

  // boss
  if(g.boss){
    ctx.save();
    // body
    ctx.fillStyle = '#ff7b7b';
    roundRect(ctx, g.boss.x, g.boss.y, g.boss.w, g.boss.h, 10); ctx.fill();
    // eyes or details
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(g.boss.x+28, g.boss.y+16, 30, 12);
    ctx.fillRect(g.boss.x + g.boss.w - 58, g.boss.y+16, 30, 12);
    // hp bar
    const barW = g.boss.w * 0.8;
    const bx = g.boss.x + (g.boss.w - barW)/2;
    ctx.fillStyle = '#222';
    roundRect(ctx, bx, g.boss.y + g.boss.h + 8, barW, 10, 6); ctx.fill();
    const hpFrac = clamp(g.boss.hp / g.boss.maxHp, 0, 1);
    ctx.fillStyle = '#73f0a6';
    roundRect(ctx, bx, g.boss.y + g.boss.h + 8, barW * hpFrac, 10, 6); ctx.fill();
    ctx.restore();
  }

  // overlay text
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(8,8,260,42);
  ctx.fillStyle = '#bde4f9'; ctx.font = '14px system-ui';
  ctx.fillText(`Score: ${Math.floor(g.score)}`, 16, 28);
  ctx.fillText(`Lives: ${g.lives}  Level: ${g.level}`, 140, 28);

  // paused / gameover overlay
  if(!g.running){
    ctx.fillStyle = 'rgba(2,6,23,0.7)'; ctx.fillRect(LOGICAL_W/2 - 200, LOGICAL_H/2 - 60, 400, 120);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '20px system-ui';
    ctx.fillText('Game Over', LOGICAL_W/2, LOGICAL_H/2 - 6);
    ctx.font = '14px system-ui'; ctx.fillText('Press R to restart', LOGICAL_W/2, LOGICAL_H/2 + 18);
    ctx.textAlign = 'left';
  } else if(g.paused){
    ctx.fillStyle = 'rgba(2,6,23,0.6)'; ctx.fillRect(LOGICAL_W/2 - 160, LOGICAL_H/2 - 36, 320, 72);
    ctx.fillStyle = '#e6f7ff'; ctx.textAlign = 'center'; ctx.font = '18px system-ui';
    ctx.fillText('Paused — press Space to resume', LOGICAL_W/2, LOGICAL_H/2 + 6);
    ctx.textAlign = 'left';
  }
}

/* helper draws */
function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}

/* color adjust */
function shadeColor(hex, shade){
  // accepts #rrggbb and shade 0..1 (1 is original, less is darker)
  try{
    if(hex[0] !== '#') return hex;
    const h = hex.slice(1);
    const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    const nr = Math.max(0, Math.min(255, Math.floor(r * shade)));
    const ng = Math.max(0, Math.min(255, Math.floor(g * shade)));
    const nb = Math.max(0, Math.min(255, Math.floor(b * shade)));
    return `rgb(${nr},${ng},${nb})`;
  } catch(e){ return hex; }
}
function pickPowerColor(type){
  switch(type){
    case 'expand': return '#60a5fa';
    case 'multiball': return '#f472b6';
    case 'slow': return '#facc15';
    case 'laser': return '#ffd86b';
    case 'shield': return '#34d399';
    default: return '#ddd';
  }
}

/* --------- highscore --------- */
function checkHighscore(s){
  if(s > highScore){
    highScore = Math.floor(s);
    localStorage.setItem(STORAGE_KEY, highScore.toString());
    alert('New high score: ' + highScore);
    highEl.textContent = highScore;
  }
}

/* --------- UI buttons --------- */
startBtn.addEventListener('click', ()=>{ if(!game || !game.running) startGame(); else { game.paused = false; }});
pauseBtn.addEventListener('click', ()=>{ if(game){ game.paused = !game.paused; updateUI(); }});
restartBtn.addEventListener('click', ()=> restartGame());

/* initial */
localStorage.setItem(STORAGE_KEY, localStorage.getItem(STORAGE_KEY) || '0');
highEl.textContent = highScore;
resize(); renderPlaceholder();

/* render placeholder */
function renderPlaceholder(){
  ctx.clearRect(0,0,LOGICAL_W,LOGICAL_H);
  ctx.fillStyle = '#021526'; ctx.fillRect(0,0,LOGICAL_W,LOGICAL_H);
  ctx.fillStyle = '#bde4f9'; ctx.font = '18px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('Click Start to play Advanced Brick Breaker', LOGICAL_W/2, LOGICAL_H/2);
  ctx.textAlign = 'left';
}

/* trigger loop when game exists */
function startIfNeeded(){
  if(game && game.running) return;
}
