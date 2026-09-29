/**
 * HPM 系列 flashloader（RV32）—— **自动生成，别手改**。
 * 生成：pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1
 * 出处/许可/入口表语义见 tools/target-firmware/hpm_flash_algo/README.md。
 *
 * 尺寸 1388 B（0x56c），加载地址 0x00000000。
 * 🚨 入口表**没有固定步长**（ebreak 汇编成 2 字节的 c.ebreak，实测每项 6 B）——
 *    偏移由 app/flash/hpm/entry.js 在运行时从 blob 里走一遍 jal 发现，
 *    symbols 是构建时从 ELF 取的真值，自测拿它逐项对账。
 */
export const HPM_ALGO = {
  loadAddr: 0x00000000,
  size: 1388,
  /** 构建时的符号地址（仅供自测对账，运行时不依赖它）*/
  symbols: {
    flash_init: 0x50,
    flash_erase: 0x110,
    flash_program: 0x224,
    flash_read: 0x268,
    flash_get_info: 0x2ac,
    flash_erase_chip: 0x2ca,
    flash_deinit: 0x302,
  },
  /** xpi_nor_config_option_t 头字：words(4bit) | tag(0xfcf90) << 12 */
  headerWords1: 0xFCF90001,
  headerWords2: 0xFCF90002,
  headerWords0: 0xFCF90000,
  b64: [
    '7wAABQKQ7wCgEAKQ7wCAIQKQ7wBgJQKQ7wBAKQKQ7wDAKgKQ7wDgLQKQnEEFR72LY3/3AJxFBWcTBwfw+Y8TBwAQY5bnACMg',
    'BQYjIgUGgoA5cUrYFwkAAAMpiVCDRwkAJtoG3iLcTtZS1FbSlwQAAIOkRE+YwNnjNoQuirKJbSETBgAQgUUXBQAAAyXlTALM',
    'As5dISLKHYAJiJcHAACDp+dLgMM3BAIgEwQE8FxIiECTCsEA/EdSxk7IVoaXBQAAg6WFSYKXBe1YSLcHAVaTh/cvFENj9dcA',
    'PFuIQIKXiEDWhaE3lwcAAIOnB0cjigcCg0cJAIHnhUcjAPkAAUXyUGJU0lRCWbJZIlqSWiFhgoC3BwIgk4cH8NhLeXFK0DKJ',
    'EEO3BwFWBtYi1CbSTs5SzFbKk4f3L66GY/THALOGpQAXBgAAAyZGQYNUhgKqBGNumQoz+pYCs4lEQWOHNAOXBQAAg6WlPxcF',
    'AAADJaU/HE+MQQhBToc2xoKXKoRR6bJGMwmZQFKZzpZKhDcJAiCXCQAAg6mpPBcKAAADKqo8EwkJ8JcKAACDqio7Y+GEBC3A',
    'twcCIJOHB/DcSyKHlwUAAIOlxTkiVBcFAAADJaU5slCSVAJZ8kliStJKnE+MQQhBFwYAAAMmRjdFYYKHgydJAYOlCQADJQoA',
    '3FNWhjbGgpcZ5bJGBYymlk23SoRNtyqEslAihSJUklQCWfJJYkrSSkVhgoC2h7cGAiCThgbwLofMSrcGAVaThvYvA6gFAGPz',
    'BgEqlwOohQIXBQAAAyWFMZcFAACDpYUwjEEIQbKGFwYAAAMmZi8CiLaHtwYCIJOGBvAyh9BKtwYBVpOG9i8DKAYAY/MGASqX',
    'roYXBQAAAyVlLZcFAACDpWUsAyjGAoxBCEEXBgAAAyYmKwKICUWJzRcHAAADJ0cqHFMBRaoHnMGDV2cCqgfcwYKAtwcCIJOH',
    'B/DcSxcHAAADJ0coDEMXBwAAAycnKNxPCENBEQbGFwYAAAMmZiaClw8QAACyQEEBgoCCgGFkZHJlc3MgJSBIUE1fTDFDX0NB',
    'Q0hFTElORV9TSVpFID09IDAAAABFOi9zZGtfZW52X3YxLjExLjAvaHBtX3Nkay9hcmNoL3Jpc2N2L2wxYy9ocG1fbDFjX2Ry',
    'di5jAHNpemUgJSBIUE1fTDFDX0NBQ0hFTElORV9TSVpFID09IDAAAGwxY19pY191bmxvY2sAAABsMWNfaWNfZmlsbF9sb2Nr',
    'AAAAAGwxY19pY19pbnZhbGlkYXRlAAAAbDFjX2RjX2ZsdXNoAAAAAGwxY19kY193cml0ZWJhY2sAAAAAbDFjX2RjX2ludmFs',
    'aWRhdGUAAABsMWNfZGNfdW5sb2NrAAAAbDFjX2RjX2ZpbGxfbG9jawAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8yegfImLgceJR3Owp3yCgEERk/X1DyLEBsYqhNU/skAihSJEQQGCgAAAAAAoBAAA',
    'IAQAACQEAAAcBAAA/////wAAAAA=',
  ].join(''),
};

/** 解出 blob 字节（每次调用都新建一份，避免被就地改动）*/
export function hpmAlgoBytes(){
  const bin = atob(HPM_ALGO.b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
