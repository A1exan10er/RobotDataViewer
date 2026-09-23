These tiny, synthetic three-frame MP4s test actual MP4 probing and per-camera timestamp assignment without any customer recordings. Generate each with FFmpeg, replacing RATE with 30 or 60:

`ffmpeg -f lavfi -i color=c=navy:size=96x64:rate=RATE -frames:v 3 -c:v libx264 -pix_fmt yuv420p -threads 1 -movflags +faststart timing-RATEfps.mp4`
