require('./_envload.cjs');
console.log('DATABASE_URL present:', !!process.env.DATABASE_URL);
console.log('SESSION_SECRET present:', !!process.env.SESSION_SECRET);
console.log('DATABASE_URL prefix:', (process.env.DATABASE_URL || '').slice(0, 30));
