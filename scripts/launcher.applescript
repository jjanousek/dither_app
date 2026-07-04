-- Ditherlab launcher: starts the local server (if needed) and opens the app.
-- __PROJECT_DIR__ is substituted by scripts/build-app.sh at build time.
set projectDir to "__PROJECT_DIR__"
set appURL to "http://127.0.0.1:8173"

try
	do shell script "export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin
cd " & quoted form of projectDir & " || exit 40
command -v python3 >/dev/null 2>&1 || exit 42
if lsof -nP -iTCP:8173 -sTCP:LISTEN >/dev/null 2>&1; then
  # something is listening — make sure it is actually Ditherlab
  curl -s --max-time 2 " & quoted form of appURL & " | grep -qi ditherlab || exit 43
else
  nohup python3 -m http.server 8173 --bind 127.0.0.1 >/dev/null 2>&1 &
  # wait for the server to come up (max ~3s)
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    curl -s --max-time 1 " & quoted form of appURL & " >/dev/null 2>&1 && break
    sleep 0.2
  done
fi
open " & quoted form of appURL
on error errMsg number errNum
	if errNum is 40 then
		display dialog "Ditherlab folder not found at:" & return & projectDir buttons {"OK"} default button 1 with icon caution
	else if errNum is 42 then
		display dialog "Ditherlab needs python3. Install the Xcode Command Line Tools (run 'xcode-select --install' in Terminal) and try again." buttons {"OK"} default button 1 with icon caution
	else if errNum is 43 then
		display dialog "Port 8173 is in use by another program, so Ditherlab can't start there. Quit that program and try again." buttons {"OK"} default button 1 with icon caution
	else
		display dialog "Ditherlab could not start: " & errMsg buttons {"OK"} default button 1 with icon caution
	end if
end try
