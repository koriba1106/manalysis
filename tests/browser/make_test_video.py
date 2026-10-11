"""テスト動画(640x480, 30fps, 240フレーム)を作る。各フレーム左上に番号(8bit)のバイナリブロック、骨盤位置にマゼンタの目印。"""
import subprocess
import sys

import cv2
import numpy as np

out = sys.argv[1]
tmp = out + ".tmp.mp4"
W, H, N, FPS = 640, 480, 240, 30
wr = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
for i in range(N):
    img = np.full((H, W, 3), 90, np.uint8)
    cv2.rectangle(img, (0, 0), (W, H // 3), (110, 100, 95), -1)
    cv2.circle(img, (320, 300), 5, (255, 0, 255), -1)
    for k in range(8):
        v = 255 if (i >> k) & 1 else 0
        cv2.rectangle(img, (4 + k * 14, 4), (4 + k * 14 + 12, 16), (v, v, v), -1)
    wr.write(img)
wr.release()
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp, "-c:v", "libvpx", "-b:v", "4M", "-crf", "8",
                "-an", out], check=True)
import os
os.remove(tmp)
print("ok", out)
