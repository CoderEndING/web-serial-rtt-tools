/** 时间/数值格式化。 */

export function pad(n, w = 2){ return String(n).padStart(w, '0'); }

/** 相对时间 hh:mm:ss.mmm（从页面打开算起也够用，这里给的是当天时间） */
export function stamp(d = new Date(), absolute = false){
  const t = absolute
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${t}.${pad(d.getMilliseconds(), 3)}`;
}

export function bytes(n){
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export function rate(n){
  if (n < 1024) return `${Math.round(n)} B/s`;
  return `${(n / 1024).toFixed(1)} KB/s`;
}

/** 文件名安全的时间戳：20260926-153012 */
export function fileStamp(d = new Date()){
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 触发浏览器下载 */
export function download(filename, content, mime = 'text/plain;charset=utf-8'){
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
