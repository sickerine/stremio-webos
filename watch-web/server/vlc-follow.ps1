# Watch party in VLC. Keeps VLC on this PC in step with the TV through the watch relay.
# The relay hands this out as /vlc.cmd with $Relay, $Token, $Room and $Version set above
# this line; run on its own, the first three come from WATCH_RELAY, WATCH_TOKEN, WATCH_ROOM.
#   WATCH_CDN_HOST    read the stream from this CDN node instead of the one in the link
#                     (for a viewer on the TV's own network: see the README)
#   WATCH_VLC_ARGS    extra VLC arguments, e.g. --fullscreen
#   WATCH_OFFSET_MS   play this much later than the TV (negative: earlier), default 0
#   WATCH_DEBUG=1     write every reading and action to %TEMP%\watch-party-vlc\follow.log
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 has.
$ErrorActionPreference = 'Stop'
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture   # numbers with a dot, whatever the PC's region
if (-not $Relay) { $Relay = $env:WATCH_RELAY }
if (-not $Token) { $Token = $env:WATCH_TOKEN }
if (-not $Room)  { $Room = if ($env:WATCH_ROOM) { $env:WATCH_ROOM } else { 'home' } }
function Say([string]$text) { Write-Host ("`r" + $text.PadRight(78)) }
function Status([string]$text) { Write-Host ("`r" + $text.PadRight(78)) -NoNewline }
if (-not $Relay) { Say 'This file has no watch party address in it. Download it again from the watch page.'; exit 1 }
$OffsetS = if ($env:WATCH_OFFSET_MS) { [double]$env:WATCH_OFFSET_MS / 1000 } else { 0.0 }
try { $Host.UI.RawUI.WindowTitle = 'Watch party in VLC' } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

# How closely VLC is held to the TV. All of these come from measurements (see the README):
# VLC refreshes its position about four times a second and not at all while paused. It
# runs its control page the moment a request arrives (0.3 ms after it is sent) and only then
# sits on the answer for 20 ms, so a reading belongs to the moment it was asked for. A
# speed change takes hold at once and leaves a click of a wave or two in the sound.
# Let go after a seek at any speed but 1, VLC starts ahead of where it was put by what it
# had buffered times (speed - 1): none, one or two seconds' worth, differently each time.
# So VLC is always paused, moved and let go at speed 1, and given its speed once it moves.
$Dead     = 0.010     # a gap this small is left alone
$SmallGap = 0.040     # up to here a gap is closed gently, and a measured one only once four refreshes agree on it
$SlowStep = 0.05      # speed change for a small gap
$FastStep = 0.10      # and for a larger one
$JumpBand = 0.30      # beyond this a burst would take over three seconds: jump instead
$Acts     = 0.011     # VLC acts on a command this long after it is sent (moves after 8 to 12 ms, stops after 9 to 16)

# Unix time in ms, with fractions, counted by a stopwatch from one reading of the system clock:
# a correction of the PC's clock in the middle of an episode must not move VLC.
$stopwatch = [Diagnostics.Stopwatch]::StartNew(); $startedAt = ([DateTime]::UtcNow.Ticks - 621355968000000000) / 10000.0
function Now { $startedAt + $stopwatch.Elapsed.TotalMilliseconds }
# Typed on purpose. [Math]::Max(0, $x) picks its integer form when $x came out of JSON and
# rounds it: the TV's position then moved in one-second steps.
function Clamp([double]$value, [double]$low, [double]$high) { if ($value -lt $low) { $low } elseif ($value -gt $high) { $high } else { $value } }

# ---- VLC ----------------------------------------------------------------------
function Find-Vlc {
    $found = @("$env:ProgramFiles\VideoLAN\VLC\vlc.exe", "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($found) { return $found }
    foreach ($key in 'HKLM:\SOFTWARE\VideoLAN\VLC', 'HKLM:\SOFTWARE\WOW6432Node\VideoLAN\VLC') {
        $dir = (Get-ItemProperty $key -ErrorAction SilentlyContinue).InstallDir
        if ($dir -and (Test-Path "$dir\vlc.exe")) { return "$dir\vlc.exe" }
    }
    return $null
}
$vlcExe = Find-Vlc
if (-not $vlcExe -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    Say 'VLC is not installed. Installing it now (Windows will ask for permission)...'
    winget install --id VideoLAN.VLC -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    $vlcExe = Find-Vlc
}
if (-not $vlcExe) {
    Say 'VLC is not installed. Install it from https://www.videolan.org/vlc/ and run this again.'
    Start-Process 'https://www.videolan.org/vlc/'
    exit 1
}

# VLC's web interface serves any text file in its folder as a Lua page. This one page is
# the whole control surface: exact time and length in microseconds, which the stock
# status page rounds to whole seconds, the buffer level, and the few commands the follower sends.
# Numbers cross as integers so no locale's decimal comma can get in the way.
$page = @'
<?vlc
local g = _GET
if g.open then
  local options = g.o
  if type(options) ~= "table" then options = { options } end
  vlc.playlist.clear()
  vlc.playlist.add({{ path = g.open, name = g.name, options = options }})
end
if g.stop then vlc.playlist.stop() end
local input = vlc.object.input()
if input then
  if g.t then vlc.var.set(input, "time", tonumber(g.t)) end
  if g.rate then vlc.var.set(input, "rate", tonumber(g.rate) / 10000) end
  local playing = vlc.playlist.status() == "playing"
  if (g.pause == "1" and playing) or (g.pause == "0" and vlc.playlist.status() == "paused") then vlc.playlist.pause() end
end
local t, length, rate, cache, item = -1, -1, 10000, -1, 0
if input then
  local uri = (vlc.input.item() and vlc.input.item():uri()) or ""   -- a number that stands for what is open
  for i = 1, #uri do item = (item * 31 + uri:byte(i)) % 2147483647 end
  t = vlc.var.get(input, "time")
  length = vlc.var.get(input, "length")
  rate = vlc.var.get(input, "rate") * 10000
  local ok, level = pcall(vlc.var.get, input, "cache")   -- how full the buffer is after a load or seek, 0 to 1
  if ok and level then cache = level * 1000 end
end
print(string.format("%.0f %.0f %.0f %s %.0f %.0f", t, length, rate, vlc.playlist.status(), cache, item))
?>
'@
$work = Join-Path $env:TEMP 'watch-party-vlc'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$trace = if ($env:WATCH_DEBUG) { New-Object IO.StreamWriter ((Join-Path $work 'follow.log'), $false) } else { $null }
function Trace([string]$text) { if ($trace) { $trace.WriteLine(('{0:0} {1}' -f (Now), $text)); $trace.Flush() } }
[IO.File]::WriteAllText((Join-Path $work 'follow.txt'), $page, (New-Object Text.UTF8Encoding $false))

$listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$secret = [guid]::NewGuid().ToString('N')
$vlcArgs = @('--extraintf=http', '--http-host=127.0.0.1', "--http-port=$port", "--http-password=$secret", "--http-src=`"$work`"",
    '--no-one-instance', '--no-qt-privacy-ask', '--no-qt-updates-notif', '--no-video-title-show')
# In this window the keys for pause, seek and speed do nothing: a slip of the hand would only
# throw VLC off until it is pulled back. These are launch options, so nothing is saved and
# the viewer's own VLC keeps its keys. The buttons on VLC's bar are left as they are.
foreach ($key in 'play-pause', 'pause', 'play', 'stop', 'faster', 'slower', 'rate-normal', 'rate-faster-fine', 'rate-slower-fine', 'next', 'prev', 'frame-next',
    'jump-extrashort', 'jump+extrashort', 'jump-short', 'jump+short', 'jump-medium', 'jump+medium', 'jump-long', 'jump+long', 'chapter-prev', 'chapter-next',
    'nav-left', 'nav-right') { $vlcArgs += "--key-$key=" }      # the plain arrows: outside a disc menu, left and right seek 10 s
$vlcArgs += '--hotkeys-x-wheel-mode=-1'       # a sideways scroll would seek
if ($env:WATCH_VLC_ARGS) { $vlcArgs += $env:WATCH_VLC_ARGS }
$vlc = Start-Process -FilePath $vlcExe -ArgumentList $vlcArgs -PassThru
$http = New-Object Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(4)
$http.DefaultRequestHeaders.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue ('Basic', [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$secret")))

# One request: send `query` (may be empty) and read VLC back. `at` is the local time the
# reading belongs to: when VLC got the request, not when its answer came. `took` is the
# whole exchange. Returns $null when VLC does not answer.
function Vlc([string]$query = '') {
    $before = Now
    try { $text = $http.GetStringAsync("http://127.0.0.1:$port/follow.txt$query").GetAwaiter().GetResult() } catch { return $null }
    $after = Now
    $part = $text.Trim() -split '\s+'
    if ($part.Count -lt 4) { return $null }
    # ready: VLC has buffered enough to play the moment it is let go (a VLC that does not say counts as ready)
    $cache = if ($part.Count -gt 4) { [double]$part[4] } else { -1 }
    return @{ t = [double]$part[0] / 1e6; length = [double]$part[1] / 1e6; rate = [double]$part[2] / 10000; status = $part[3]; ready = ($cache -lt 0 -or $cache -ge 990)
        item = $(if ($part.Count -gt 5) { [double]$part[5] } else { 0 }); at = $before + 0.3; took = $after - $before }
}
$ready = $false
for ($i = 0; $i -lt 150 -and -not $vlc.HasExited; $i++) { if (Vlc) { $ready = $true; break }; Start-Sleep -Milliseconds 100 }
if (-not $ready) { Say 'VLC did not start. Close any VLC windows and run this again.'; exit 1 }

# ---- relay --------------------------------------------------------------------
$ws = $null; $receive = $null; $offset = $null; $pings = New-Object Collections.ArrayList; $pongs = 0; $pingAt = 0.0; $pingCount = 0
$buffer = New-Object byte[] 65536
$segment = New-Object ArraySegment[byte] -ArgumentList @(, $buffer)
$message = New-Object IO.MemoryStream
$none = [Threading.CancellationToken]::None
$tv = $null          # latest TV state as plain numbers, with sampledAt in this PC's clock
# While the TV plays, its position is a line. Each report gives the line's offset with a
# little noise; VLC is held to the middle one of the last 21 (ten seconds' worth), so that
# the noise is not chased. A report well off that line is a jump and starts a new one, and
# so do three in a row that are off it by less to the same side.
$tvLine = @{ key = ''; offset = 0.0; reports = New-Object Collections.ArrayList }
$tvNoise = 0.0       # seconds; known once a line has six reports
$tvDoing = ''
$newsDelays = New-Object Collections.ArrayList   # how old the TV's last few reports were on arrival, ms
$media = $null       # @{ session; url } once the relay has resolved the stream
$queued = New-Object Collections.ArrayList   # messages that arrived before the clocks were paired

function Send-Relay($object) {
    if (-not $ws -or $ws.State -ne 'Open') { return }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($object | ConvertTo-Json -Compress -Depth 6))
    try { $ws.SendAsync((New-Object ArraySegment[byte] -ArgumentList @(, $bytes)), 'Text', $true, $none).Wait(3000) | Out-Null } catch {}
}
function Connect-Relay {
    $script:offset = $null; $script:pings.Clear(); $script:pingCount = 0; $script:pingAt = 0.0; $script:receive = $null; $script:queued.Clear(); $script:message.SetLength(0)
    $socket = New-Object Net.WebSockets.ClientWebSocket
    if ($Token) { $socket.Options.SetRequestHeader('Cookie', "watch_auth=$Token") }
    $separator = if ($Relay.Contains('?')) { '&' } else { '?' }
    try {
        if (-not $socket.ConnectAsync([Uri]"$Relay${separator}room=$Room&role=viewer", $none).Wait(10000)) { throw 'timeout' }
        $script:ws = $socket; return $true
    } catch {
        $script:ws = $null
        # The refusal sits several exceptions deep (PowerShell, the task, the socket, the web request).
        for ($e = $_.Exception; $e; $e = $e.InnerException) { if ($e.Message -match '\(401\)') { $script:refused = $true } }
        return $false
    }
}
function Handle($m) {
    if ($m.type -eq 'hello' -and $Version -and $m.follower -and $m.follower -ne $Version) { $script:stale = $true; return }
    if ($m.type -eq 'pong') {
        $now = Now
        # The relay stamped its answer some time between the ping leaving and the answer
        # arriving. That bounds how far this clock is ahead of the relay's, and all recent
        # pings together bound it best: the quickest trip out sets one side, the quickest
        # trip back the other, so the middle is right even when no one ping was quick both
        # ways. A bound loosens with age by what two clocks can drift apart (50 ms in 1000 s).
        [void]$pings.Add(@{ at = $now; rtt = $now - [double]$m.t; low = [double]$m.t - [double]$m.serverMs; high = $now - [double]$m.serverMs })
        if ($pings.Count -gt 30) { $pings.RemoveAt(0) }
        $script:pongs++
        if ($pings.Count -ge 6 -or $null -ne $offset) {
            $low = -1e18; $high = 1e18
            foreach ($p in $pings) { $slack = ($now - $p.at) * 0.00005; if ($p.low - $slack -gt $low) { $low = $p.low - $slack }; if ($p.high + $slack -lt $high) { $high = $p.high + $slack } }
            if ($low -gt $high) { $pings.RemoveRange(0, $pings.Count - 1); $low = $pings[0].low; $high = $pings[0].high }   # they contradict: a clock was set. Start again from this ping.
            $shift = if ($null -ne $offset) { ($low + $high) / 2 - $offset } else { 0 }
            # A pairing in use is replaced only by one that differs by 3 ms or more: every
            # change moves the TV's line and may cost a burst, and below that it buys nothing.
            if ($null -ne $offset -and [Math]::Abs($shift) -lt 3) { return }
            if ($shift -and $tv) {
                # A better pairing moves every report the TV has made by the same amount: its line moves at once, not report by report.
                $tv.sampledAt += $shift; $tvLine.offset -= $tv.rate * $shift / 1000
                for ($i = 0; $i -lt $tvLine.reports.Count; $i++) { $tvLine.reports[$i] -= $tv.rate * $shift / 1000 }
                Trace ('clocks paired {0:+0.0;-0.0} ms differently' -f $shift)
            }
            $script:offset = ($low + $high) / 2
            $waiting = @($queued); $queued.Clear(); foreach ($q in $waiting) { Handle $q }
        }
        return
    }
    if ($null -eq $offset) { [void]$queued.Add($m); return }
    if ($m.type -eq 'hello' -or $m.type -eq 'room-state') {
        if (-not $m.state) { $script:tv = $null; $script:media = $null; return }
        $st = $m.state
        if ($tv -and $tv.sessionId -eq "$($st.sessionId)" -and $tv.sequence -ge [double]$st.sequence) { return }
        $script:tv = @{ sessionId = "$($st.sessionId)"; sequence = [double]$st.sequence; position = [double]$st.positionSeconds; sampledAt = [double]$st.sampledAtMs + $offset
            paused = [bool]$st.paused; buffering = [bool]$st.buffering; rate = [double]$st.playbackRate; title = "$($st.title)"; episodeId = "$($st.episodeId)"; mediaUrl = "$($st.mediaUrl)" }
        [void]$newsDelays.Add((Now) - $tv.sampledAt); if ($newsDelays.Count -gt 9) { $newsDelays.RemoveAt(0) }
        $moving = -not $tv.paused -and -not $tv.buffering; $key = "$($tv.sessionId)|$($tv.rate)"
        $doing = "$(if ($tv.paused) { 'paused' } elseif ($tv.buffering) { 'loading' } else { 'playing' }) $($tv.sessionId) x$($tv.rate)"
        if ($doing -ne $script:tvDoing) { $script:tvDoing = $doing; Trace ('tv {0} at {1:0.000}' -f $doing, $tv.position) }
        $offsetNow = $tv.position - $tv.rate * $tv.sampledAt / 1000
        if ($moving -and $tvLine.reports.Count -and $tvLine.key -eq $key -and [Math]::Abs($offsetNow - $tvLine.offset) -gt 0.08) { Trace ('tv jumped {0:0} ms' -f (($offsetNow - $tvLine.offset) * 1000)) }
        if (-not $moving -or $tvLine.key -ne $key -or [Math]::Abs($offsetNow - $tvLine.offset) -gt 0.08) { $tvLine.reports.Clear(); $tvLine.key = $key }
        if ($moving) {
            [void]$tvLine.reports.Add($offsetNow); if ($tvLine.reports.Count -gt 21) { $tvLine.reports.RemoveAt(0) }
            $count = $tvLine.reports.Count
            if ($count -ge 6) {
                $side = 0; for ($i = $count - 3; $i -lt $count; $i++) { $off = $tvLine.reports[$i] - $tvLine.offset; if ([Math]::Abs($off) -gt 0.03) { $side += [Math]::Sign($off) } }
                if ([Math]::Abs($side) -eq 3) { $tvLine.reports.RemoveRange(0, $count - 3); Trace 'tv shifted' }
            }
            $tvLine.offset = @($tvLine.reports | Sort-Object)[[int][Math]::Floor($tvLine.reports.Count / 2)]
            if ($tvLine.reports.Count -ge 6) {
                # How noisy this TV's reports are: the typical distance of one from the line, as a standard deviation.
                $spread = @($tvLine.reports | ForEach-Object { [Math]::Abs($_ - $tvLine.offset) } | Sort-Object)
                $script:tvNoise = 1.48 * $spread[[int][Math]::Floor($spread.Count / 2)]
            }
        }
        if ($m.cdnUrl) { $script:media = @{ session = $tv.sessionId; url = "$($m.cdnUrl)" } }
        elseif ($media -and $media.session -ne $tv.sessionId) { $script:media = $null }
    } elseif ($m.type -eq 'room-media' -and $tv -and $tv.sessionId -eq $m.sessionId) {
        if ($m.cdnUrl) { $script:media = @{ session = $tv.sessionId; url = "$($m.cdnUrl)" } }
        elseif ($m.resolveError) { Status "The stream link is not ready yet ($($m.resolveError))" }
    } elseif ($m.type -eq 'room-idle') { $script:tv = $null; $script:media = $null; $script:tvDoing = ''; Trace 'tv idle' }
}
# Reads whatever has arrived without waiting. Returns $false once the socket is gone.
function Pump-Relay {
    while ($true) {
        if (-not $script:receive) { $script:receive = $ws.ReceiveAsync($segment, $none) }
        if (-not $script:receive.IsCompleted) { return $true }
        if ($script:receive.IsFaulted -or $script:receive.IsCanceled) { return $false }
        $result = $script:receive.Result; $script:receive = $null
        if ($result.MessageType -eq 'Close') { return $false }
        $message.Write($buffer, 0, $result.Count)
        if ($result.EndOfMessage) {
            $text = [Text.Encoding]::UTF8.GetString($message.ToArray()); $message.SetLength(0)
            try { Handle (ConvertFrom-Json $text) } catch {}
        }
    }
}

# ---- follow -------------------------------------------------------------------
# Where the TV is at local time `at`. A paused or loading TV sits on its frame.
function Tv-Position([double]$at) {
    if ($tv.paused -or $tv.buffering -or -not $tvLine.reports.Count) { return Clamp ($tv.position - $OffsetS) 0 1e9 }
    return Clamp ($tvLine.offset + $tv.rate * $at / 1000 - $OffsetS) 0 1e9
}
# Waits until a moment on our clock, to the millisecond. Windows' own sleep overshoots by up
# to a timer tick (15 ms), which a timed release would turn straight into a gap.
function Wait-Until([double]$at) {
    while ($true) { $left = $at - (Now); if ($left -le 0) { return }; if ($left -gt 20) { [Threading.Thread]::Sleep([int]($left - 18)) } else { [Threading.Thread]::SpinWait(100) } }
}
function Micros([double]$seconds) { [string][long][Math]::Round((Clamp $seconds 0 1e9) * 1e6) }

$loaded = $null       # what VLC has open: session and link
$failed = $null       # the one that stopped or hung: next time it is opened through the TV's own link
$opening = $false     # told to open it, not yet seen it loaded
$openedAt = 0.0
$item = 0             # what VLC called the stream once it had loaded it; anything else is the viewer's own file
$length = 0.0         # how long the episode is
$movedAt = 0.0        # when VLC last moved, or had a reason not to
$lastT = $null        # the position VLC last reported, to spot the moment it changes
$prevAt = $null       # when that reading was taken
$rate = 1.0           # speed last sent to VLC
$rateSentAt = 0.0
# Where VLC is, worked out, not read. VLC refreshes the position it reports four times a
# second and not at all while paused, so a reading is up to a quarter of a second old.
# Every command moves this model by what that command is known to do, and each refresh
# then says how far the model is off.
$model = @{ pos = 0.0; at = 0.0; rate = 1.0; moving = $false }   # at `pos` since `at`, moving at `rate` or not
$toldAt = 0.0         # when VLC was last told to pause, play or seek; its status takes a moment to show it
$window = New-Object Collections.ArrayList     # recent refreshes, each as bounds on how far the model is off: @(low, high)
$burstStep = 0.0      # a burst of speed is running: by this much, to close a gap of this sign
$burstSign = 0
$bursts = 0
# A jump is never chased: right after a seek VLC already reports the new position while it
# is still loading, and seeking again on that reading only stacks up seeks. VLC is parked
# instead, paused, ahead of the TV, and let go as the TV arrives.
$parkedAt = 0.0
$awaitReady = $false  # a seek is filling VLC's buffer: time it
$awaitDrop = $false   # a seek was just sent: VLC's buffer level has not shown it yet
$readyTimes = New-Object Collections.ArrayList # how long the last few seeks took to be ready, seconds
$loadTimes = New-Object Collections.ArrayList  # and how long the last few files took to open
# How far ahead a file is opened: a fifth more than the slowest of the last three opens
# (opening the same TorBox stream took 3.7 to 6.0 s). The first of a session goes by what
# the last session's opens took on this PC, or 5.5 s. Too much costs little: a VLC that
# is ready long before the TV arrives is parked again, closer (see the waiting branch below).
function Open-Lead([double]$slowest) { Clamp (1.2 * $slowest + 0.3) 0.5 20 }
$openLead = 5.5
$remembered = Join-Path $work 'open-seconds.txt'
try { $openLead = Open-Lead ([double]::Parse((Get-Content $remembered -ErrorAction Stop), [Globalization.CultureInfo]::InvariantCulture)) } catch {}
$holding = $false     # the TV is paused or loading, since $heldSince
$heldSince = 0.0
$wallAt = 0.0
$fresh = $null        # VLC's last answer while it waited on the TV: still true when the TV's news cuts the wait short
$worst = 0.0; $seeks = 0; $reportAt = (Now) + 5000
$refused = $false; $stale = $false; $retryAt = 0.0; $shownIdle = $false
function RateText([double]$r) { [string][long][Math]::Round($r * 10000) }
function Vlc-Position([double]$at) { if ($model.moving -and $at -gt $model.at) { return $model.pos + $model.rate * ($at - $model.at) / 1000 }; return $model.pos }
# How far ahead of the TV a seek parks VLC: half as long again as the middle one of the
# last nine seeks took, plus a little. Ready early only means waiting that much; ready
# late means a burst ten times as long as the lateness, or another seek. On every link
# measured, ordinary seeks stay within half as much again as their middle one. The CDN
# also has slow ones (5 to 10 s where 1 s is usual, up to four in ten to a part of the
# file it has not served yet): those cannot be waited out every time, so they are left
# to come back late, and the park that follows, close to where VLC then is, is quick.
# Before the first seek has been timed, opening the file is the guide: a seek took a
# fifth to a third as long as an open, on every link measured.
function Lead {
    if (-not $readyTimes.Count) { return $(if ($loadTimes.Count) { Clamp (0.4 * $loadTimes[$loadTimes.Count - 1] + 0.15) 0.3 2.5 } else { 2.5 }) }
    $sorted = @($readyTimes | Sort-Object); return Clamp (1.5 * $sorted[[int][Math]::Floor(($sorted.Count - 1) / 2)] + 0.15) 0.15 8
}
# How far past a waiting TV's frame VLC waits: what the TV covers between playing again and
# VLC moving on the news of it. Then VLC starts level and needs no catching up. The news
# takes as long as the TV's quicker reports do; the slower ones were sampled before they left.
function Hold-Lead {
    if (-not $newsDelays.Count) { return 0.05 }
    $sorted = @($newsDelays | Sort-Object)
    return Clamp ($tv.rate * ($sorted[[int][Math]::Floor($sorted.Count / 4)] / 1000 + $Acts + 0.01)) 0.03 0.25
}
# How far the model is off, as far as all recent refreshes agree. A refresh that contradicts
# the older ones means VLC has shifted since, so the older ones go.
function Estimate {
    while ($window.Count) {
        $low = -1e9; $high = 1e9
        foreach ($w in $window) { if ($w[0] -gt $low) { $low = $w[0] }; if ($w[1] -lt $high) { $high = $w[1] } }
        if ($low -le $high) { return @{ gap = ($low + $high) / 2; width = $high - $low; n = $window.Count } }
        $window.RemoveAt(0)
    }
    return $null
}
# The commands. Each one moves the model to what VLC will be doing once it has acted.
function Set-Rate([double]$r) {
    if ($r -eq $rate) { return }
    $done = (Now) + $Acts * 1000
    [void](Vlc ('?rate=' + (RateText $r)))
    $model.pos = Vlc-Position $done; $model.at = $done; $model.rate = $r
    $script:rate = $r; $script:rateSentAt = Now
}
function Pause-Vlc {
    $done = (Now) + $Acts * 1000
    [void](Vlc '?pause=1')
    $model.pos = Vlc-Position $done; $model.moving = $false
    $script:toldAt = Now; $script:burstStep = 0.0; $script:lastT = $null   # the next reading is what a paused VLC shows from here on
}
function Let-Go {
    $done = (Now) + $Acts * 1000
    [void](Vlc '?pause=0')
    $model.at = $done; $model.rate = $rate; $model.moving = $true
    $script:toldAt = Now; $script:movedAt = $toldAt; $window.Clear(); $script:lastT = $null; $script:prevAt = $null
}
# Puts VLC on `target`, paused. $playing: it is playing now and has to be paused as well.
function Put([double]$target, [bool]$playing) {
    # The speed goes to 1 first, while VLC still plays (see the top of the file). Then the
    # pause, and only then the seek: a paused VLC shows a seek in its buffer level at once
    # (in the answer to the seek itself, or the next), a playing one only tens of ms later,
    # and until it does the full buffer it still reports would pass for a finished seek.
    if ($playing) { Set-Rate 1; Pause-Vlc }
    $sent = Now; $answer = Vlc ('?t=' + (Micros $target))
    $model.pos = $target; $model.moving = $false
    $script:toldAt = Now; $script:parkedAt = $sent; $script:awaitReady = $true; $script:burstStep = 0.0; $script:seeks++
    $script:awaitDrop = -not $answer -or $answer.ready
    $window.Clear(); $script:lastT = $null; $script:prevAt = $null
}
function Park([bool]$playing) {
    $span = Lead; Put ((Tv-Position (Now)) + $span * $tv.rate) $playing      # the lead is time; the TV covers its speed's worth of it
    Status 'Catching up with the TV...'
    Trace ('park at {0:0.000}, {1:0.00} s ahead' -f $model.pos, $span)
}
# Runs VLC at the speed that closes the gap to the TV, then at the TV's own. Returns the gap
# (positive: VLC is ahead).
function Steer {
    $gap = (Vlc-Position (Now)) - (Tv-Position (Now))
    if ($burstStep -gt 0) {
        # A burst ends when the gap is gone. How long that takes is worked out again each
        # time round, from a model the refreshes keep correcting while the burst runs.
        $left = if ([Math]::Sign($gap) -eq $burstSign) { [Math]::Abs($gap) / ($burstStep * $tv.rate) * 1000 } else { 0 }
        if ($left -le 45) {
            Wait-Until ((Now) + $left - $Acts * 1000)
            Set-Rate $tv.rate; $script:burstStep = 0.0
            Trace 'speed back'
        } else { Set-Rate ($tv.rate * (1 - $burstSign * $burstStep)) }   # sends only if the TV's own speed has changed meanwhile
    } elseif ([Math]::Abs($gap) -gt [Math]::Max($Dead, 2.5 * $tvNoise / [Math]::Sqrt([Math]::Max(1, $tvLine.reports.Count)))) {
        # (A gap is acted on only if it is larger than the TV's line is known to: a line of
        # few noisy reports, right after the TV did something, is not chased.)
        $script:burstStep = if ([Math]::Abs($gap) -gt $SmallGap) { $FastStep } else { $SlowStep }; $script:burstSign = [Math]::Sign($gap)
        Set-Rate ($tv.rate * (1 - $burstSign * $burstStep)); $script:bursts++
        Trace ('{0:0} ms off: speed {1:0.00} for about {2:0} ms' -f ($gap * 1000), $rate, ([Math]::Abs($gap) / ($burstStep * $tv.rate) * 1000))
    } else { Set-Rate $tv.rate }
    return $gap
}
# Every five seconds, tell the relay how this viewer is doing, like the browser page does.
function Report([string]$status, [double]$t, [double]$at, [double]$gap, [double]$width) {
    if ([Math]::Abs($gap) -gt $script:worst) { $script:worst = [Math]::Abs($gap) }
    if ($at -lt $script:reportAt -or $null -eq $offset) { return }
    Send-Relay @{ type = 'netlog'; data = @{ client = 'vlc'; t = [Math]::Round($t, 3); at = [Math]::Round($at - $offset); status = $status; gapMs = [Math]::Round($gap * 1000); withinMs = [Math]::Round($width * 500)
        maxMs = [Math]::Round($worst * 1000); seeks = $seeks; bursts = $bursts; rate = $rate; leadMs = [Math]::Round((Lead) * 1000); rttMs = [Math]::Round(($pings | ForEach-Object { $_.rtt } | Measure-Object -Minimum).Minimum) } }
    $script:worst = 0.0; $script:reportAt = $at + 5000
}
$animeId = '^(kitsu|mal|anilist|anidb)[:_]'

while (-not $vlc.HasExited) {
    $now = Now
    $reuse = $fresh; $fresh = $null
    if ($trace -and $now -ge $wallAt) { Trace ('wall {0:0.0}' -f (([DateTime]::UtcNow.Ticks - 621355968000000000) / 10000.0)); $wallAt = $now + 2000 }   # this clock against the PC's own, for whoever reads the log
    if (-not $ws -or $ws.State -ne 'Open') {
        # The relay is out of reach. VLC plays on where the model has it, at the TV's own
        # speed (a burst must not outlast the news that would end it), and what the TV was
        # last doing stays in force: the relay's first message back says what has changed.
        if ($burstStep -gt 0 -and $tv) { Set-Rate $tv.rate; $burstStep = 0.0 }
        if ($now -lt $retryAt) { Start-Sleep -Milliseconds 100; continue }
        Status 'Connecting to the watch party...'
        if (-not (Connect-Relay)) {
            if ($refused) { Say 'The party password has changed. Download "Watch party in VLC" again from the watch page.'; break }
            $retryAt = (Now) + 1500; continue
        }
    }
    if (-not (Pump-Relay)) { try { $ws.Dispose() } catch {}; $ws = $null; $retryAt = (Now) + 1500; continue }
    if ($stale) { Say 'This file is out of date. Download "Watch party in VLC" again from the watch page.'; break }
    # Pair the clocks: a volley of twelve pings on connecting (twelve bounds pin the clocks
    # to a few ms even where one ping can be tens off), ten more two seconds apart, then
    # one every ten seconds. The answer is waited for here, because time it sits unread
    # loosens its bound. VLC is not attended to meanwhile, so a ping waits its turn while
    # VLC is being steered to a moment (a burst to end, a release to time), and the wait
    # is dropped when the TV does something.
    $timing = $burstStep -gt 0 -or ($tv -and $loaded -and -not $model.moving -and -not $tv.paused -and -not $tv.buffering)
    if ($now -ge $pingAt -and ($pingCount -eq 0 -or -not $timing)) {
        $had = $pongs; $was = $tvDoing; $volley = $(if ($pingCount -eq 0) { 12 } else { 1 })
        for ($i = 0; $i -lt $volley; $i++) {
            if ($i) { try { [void]$receive.Wait(15) } catch {}; if (-not (Pump-Relay)) { break } }
            $sent = Now; Send-Relay @{ type = 'ping'; t = $sent }
        }
        while ($pongs -lt $had + $volley -and $tvDoing -eq $was -and (Now) - $sent -lt 500) {
            try { [void]$receive.Wait([int][Math]::Max(1, 501 - ((Now) - $sent))) } catch {}   # woken the moment something arrives: a sleep would stamp it up to 15 ms late
            if (-not (Pump-Relay)) { break }
        }
        $pingCount += $volley; $pingAt = (Now) + $(if ($pingCount -lt 22) { 2000 } else { 10000 })
        continue
    }

    if (-not $tv) {
        if ($loaded) { [void](Vlc '?stop=1'); $loaded = $null; $failed = $null; $lastT = $null; $prevAt = $null; Send-Relay @{ type = 'netlog'; data = @{ client = 'vlc'; status = 'idle' } } }
        if (-not $shownIdle) { Status 'Connected. Waiting for the TV to play something.'; $shownIdle = $true }
        Start-Sleep -Milliseconds 100; continue
    }
    $shownIdle = $false
    if (-not $media -or $media.session -ne $tv.sessionId) {
        if ($loaded) { [void](Vlc '?stop=1'); $loaded = $null; $lastT = $null; $prevAt = $null }   # the TV moved on: do not keep playing the last episode
        Status 'Getting the stream link...'; Start-Sleep -Milliseconds 50; continue
    }

    $hold = $tv.paused -or $tv.buffering
    if (-not $hold) { $holding = $false } elseif (-not $holding) { $holding = $true; $heldSince = $now }
    $wanted = "$($media.session)|$($media.url)"
    if ($loaded -ne $wanted) {
        # A new episode. It opens paused, parked where the TV should be once VLC has it loaded.
        $start = (Tv-Position $now) + $(if ($hold) { Hold-Lead } else { $openLead * $tv.rate })
        $options = '&o=' + [Uri]::EscapeDataString(':start-paused') + '&o=' + [Uri]::EscapeDataString(':start-time=' + $start.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture))
        if ("$($tv.episodeId)" -match $animeId) { $options += '&o=' + [Uri]::EscapeDataString(':audio-language=jpn,ja') + '&o=' + [Uri]::EscapeDataString(':sub-language=eng,en') }
        $name = if ($tv.title) { "$($tv.title)" } else { 'Watch party' }
        # The relay's link is the CDN's own and expires. After a failure, open the link the TV
        # itself uses: it leads to a fresh one every time, at the cost of a slower start and seek.
        $url = if ($failed -eq $wanted -and $tv.mediaUrl -and -not $env:WATCH_CDN_HOST) { $tv.mediaUrl } else { $media.url }
        if ($env:WATCH_CDN_HOST) { $swap = New-Object UriBuilder $url; $swap.Host = $env:WATCH_CDN_HOST; $url = $swap.Uri.AbsoluteUri }
        [void](Vlc ("?open=" + [Uri]::EscapeDataString($url) + "&name=" + [Uri]::EscapeDataString($name) + $options))
        $loaded = $wanted; $opening = $true; $item = 0; $length = 0.0; $openedAt = $now; $movedAt = $now; $parkedAt = $now; $toldAt = $now; $awaitReady = $false
        $lastT = $null; $prevAt = $null; $rate = 1.0; $burstStep = 0.0; $window.Clear()
        $model.pos = $start; $model.rate = 1.0; $model.moving = $false
        Say "Playing $name"
        Trace ('open at {0:0.000}, {1:0.00} s ahead, hold={2}' -f $start, $openLead, $hold)
        continue
    }

    $s = if ($reuse -and -not $hold) { $reuse } else { Vlc }
    if (-not $s) { Start-Sleep -Milliseconds 50; continue }
    if ($s.status -eq 'stopped' -or $s.t -lt 0) {
        if ($opening) {
            # Still opening. A link that will not open within a minute is given up on.
            if ($now - $openedAt -gt 60000) { $failed = $loaded; $loaded = $null } else { Status 'Loading the stream...' }
        } elseif ($length -gt 0 -and (Tv-Position $now) -gt $length - 3) {
            # The episode is over here and nearly over on the TV: wait for the TV to move on.
        } elseif ($now - $openedAt -gt 10000) {
            # It was playing and now it is not: the viewer pressed Stop, or the stream broke.
            # Open it again, not more often than every ten seconds.
            Trace 'stopped; opening again'; $loaded = $null
        }
        Start-Sleep -Milliseconds 100; continue
    }
    if ($opening) {
        # Loaded means paused where it was told to start, with its buffer full. A VLC that
        # never reports that pause counts as loaded once it has been playing for a while.
        $isLoaded = ($s.status -eq 'paused' -and $s.ready) -or ($s.status -eq 'playing' -and $now - $openedAt -gt 8000)
        if (-not $isLoaded) {
            if ($now - $openedAt -gt 60000) { $failed = $loaded; $loaded = $null } else { Status 'Loading the stream...' }
            continue
        }
        $opening = $false; $item = $s.item
        [void]$loadTimes.Add(($s.at - $openedAt) / 1000); if ($loadTimes.Count -gt 3) { $loadTimes.RemoveAt(0) }
        $slowest = ($loadTimes | Measure-Object -Maximum).Maximum
        $openLead = Open-Lead $slowest
        try { [IO.File]::WriteAllText($remembered, $slowest.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)) } catch {}
        if ($s.status -eq 'playing') { $model.pos = $s.t; $model.at = $s.at; $model.rate = $s.rate; $model.moving = $true }
        Trace ('loaded in {0:0.00} s; next file opens {1:0.00} s ahead' -f (($s.at - $openedAt) / 1000), $openLead)
    }
    if ($s.length -gt 0) { $length = $s.length }
    if ($item -and $s.item -and $s.item -ne $item) {
        # The viewer opened something else in this window. The party's stream goes back on.
        Trace 'another file was opened; opening the stream again'; $loaded = $null; continue
    }
    $sound = $s.took -le 35                      # a slow exchange cannot say when its reading was taken
    $changed = $null -ne $lastT -and $s.t -ne $lastT
    $before = $prevAt; $lastT = $s.t; $prevAt = $(if ($sound) { $s.at } else { $null })
    if ($changed -and $s.status -eq 'paused' -and -not $model.moving) {
        # A paused VLC changes its reading only when it has been moved (not once in 5,000
        # readings otherwise). By a few ms: it has settled on a frame after a seek, and
        # that is where it is. By more: the viewer moved it, and it is put back once the
        # buffer for where they went has filled, like any seek the follower did not send.
        $far = [Math]::Abs($s.t - $model.pos) -gt 0.25; $model.pos = $s.t
        if ($far) { $parkedAt = $now; $awaitDrop = $true; $awaitReady = $false; Trace ('the viewer moved it to {0:0.000}' -f $s.t) }
    }
    if ($awaitDrop) {
        # The seek has not shown in VLC's buffer level yet. Full counts only once the level
        # has been seen to drop, or 80 ms on (three answers): then the seek needed no filling.
        if (-not $s.ready -or $now - $parkedAt -gt 80) { $awaitDrop = $false } else { $s.ready = $false }
    }
    if ($awaitReady -and $s.status -eq 'paused' -and $s.ready) {
        # The seek's buffer is full: that is how long a seek takes on this connection.
        [void]$readyTimes.Add(($s.at - $parkedAt) / 1000); if ($readyTimes.Count -gt 9) { $readyTimes.RemoveAt(0) }
        $awaitReady = $false
        Trace ('ready {0:0.00} s after the seek' -f (($s.at - $parkedAt) / 1000))
    }
    if ($now - $toldAt -gt 150 -and ($s.status -eq 'playing') -ne $model.moving) {
        # VLC is in a state it was not told to be in: the viewer paused it or pressed play,
        # some time between the last reading and this one.
        $when = if ($null -ne $before) { ($before + $s.at) / 2 } else { $s.at - 10 }
        if ($model.moving) { $model.pos = Vlc-Position $when; $model.moving = $false }
        else { $model.at = $when; $model.rate = $s.rate; $model.moving = $true; $window.Clear() }
        Trace ('the viewer {0} at {1:0.000}' -f $(if ($model.moving) { 'pressed play' } else { 'paused' }), $model.pos)
    }

    # A seek is sent only once the one before it has filled VLC's buffer, whoever sent that:
    # sent into a seek that is still filling, it took TorBox 3.8 to 5.6 s where the same
    # seek alone took 1.0 to 2.5, and the CDN bans an address that stacks connections. A
    # seek that has not filled in 12 s (the slowest seen took 10.5) is given up on.
    $settled = $s.ready -or $now - $parkedAt -gt 12000

    if ($hold) {
        # The TV sits on a frame. VLC waits just past it (see Hold-Lead).
        $movedAt = $now
        if ($s.status -eq 'playing') {
            if ($model.moving) { Set-Rate 1; Pause-Vlc; Trace ('paused at {0:0.000}' -f $model.pos) }   # the speed before the pause, never during it
            continue
        }
        $lead = Hold-Lead; $off = $model.pos - (Tv-Position $now)
        # Stopped where it happened to be, VLC is usually already that far past the TV: the
        # news of the pause took as long to arrive. It is moved only when it is well off,
        # and then not before the TV has sat still a moment: a seek empties VLC's buffer,
        # and a TV that plays again at once is better met with what VLC has.
        # Never while the last seek is still filling (see $settled).
        if (($off -lt $lead - 0.08 -or $off -gt $lead + 0.15) -and $settled -and ([Math]::Abs($off) -gt 1 -or $now - $heldSince -gt 400)) {
            Put ((Tv-Position $now) + $lead) $false
            Trace ('wait at {0:0.000}, {1:0} ms past the TV' -f $model.pos, ($lead * 1000))
            continue
        }
        if (-not $awaitReady) { Report 'paused' $model.pos $s.at $off 0 }
        Status $(if ($tv.paused) { 'Paused on the TV' } else { 'The TV is loading' })
        # Nothing moves until the TV does, and that news comes from the relay: wait on it,
        # and when it comes act on it at once, without asking VLC again first.
        if (-not $awaitReady -and $s.ready -and $receive) { try { if ($receive.Wait(200)) { $fresh = $s } } catch {} }
        continue
    }

    if ($s.status -eq 'paused') {
        # The TV is playing and VLC waits: just loaded, parked by a jump, paused by the
        # viewer, or the TV has just resumed.
        if ($model.moving) { continue }                                # just let go: VLC does not show it yet
        $movedAt = $now; $burstStep = 0.0
        if (-not $s.ready) {
            # Still filling its buffer. A stream that never gets there is opened again.
            if ($now - $parkedAt -gt 20000) { Trace 'never ready; opening again'; $failed = $loaded; $loaded = $null }
            continue
        }
        $ahead = $model.pos - (Tv-Position ((Now) + $Acts * 1000))     # how far ahead of the TV VLC would be if let go now
        $wait = $ahead / $tv.rate                                      # and how long until the TV gets there
        # The TV is too far behind to wait for (it skipped back, or VLC was ready much sooner
        # than allowed for and a seek closer is quicker than the wait), or too far ahead to
        # catch with a burst (it skipped on, or VLC took too long): park again.
        if ($wait -gt (Lead) + 0.5 -or $ahead -lt -$JumpBand) { Park $false; continue }
        if ($wait -gt 0.03) { continue }                               # the TV is not here yet: the next exchange is the wait
        if ($wait -gt 0) { Wait-Until ((Now) + $wait * 1000) }
        # Let go. Whatever VLC starts behind (the news came late, or the buffer filled late)
        # is made up by a burst of speed, sent in its own command after the release, never
        # with it (see Put).
        Let-Go
        Trace ('let go at {0:0.000}{1}' -f $model.pos, $(if ($ahead -lt 0) { ', {0:0} ms behind' -f (-$ahead * 1000) } else { '' }))
        [void](Steer)
        continue
    }

    # Both are playing.
    if ([Math]::Abs($s.rate - $rate) -gt 0.003 -and $now - $rateSentAt -gt 150) {
        # The viewer changed the speed. It goes back, and the model takes what that covered.
        Trace ('speed was {0:0.00}, not {1:0.00}: put back' -f $s.rate, $rate)
        $since = if ($null -ne $before) { ($before + $s.at) / 2 } else { $s.at }
        $done = (Now) + $Acts * 1000
        [void](Vlc ('?rate=' + (RateText $rate))); $rateSentAt = Now
        if ($model.moving) { $model.pos += ($s.rate - $rate) * ($done - $since) / 1000 }
        continue
    }
    if ($changed) { $movedAt = $now }
    elseif ($now - $movedAt -gt 15000) { Trace 'stalled; opening again'; $failed = $loaded; $loaded = $null; continue }   # "playing" but not moving: the connection hung
    $width = 0.0
    if ($changed -and $sound -and $null -ne $before -and $before -gt $model.at) {
        # VLC's position just refreshed, some time between the last reading and this one.
        # That bounds how far VLC is from where the model has it (positive: further on);
        # several refreshes together pin it down to a couple of milliseconds.
        $low = $s.t - (Vlc-Position $s.at); $high = $s.t - (Vlc-Position $before)
        Trace ('edge t={0:0.000} read {1:0.0}..{2:0.0} gap {3:0}..{4:0} model {5:0}..{6:0} rate={7:0.000}' -f $s.t, $before, $s.at, (($s.t - (Tv-Position $s.at)) * 1000), (($s.t - (Tv-Position $before)) * 1000), ($low * 1000), ($high * 1000), $rate)
        if ([Math]::Abs(($low + $high) / 2) -gt $JumpBand) {
            # VLC is not where it should be: the viewer moved it, or the stream stalled. It
            # is stopped there, and the waiting branch parks it from there once its buffer
            # is full (see $settled).
            Set-Rate 1; Pause-Vlc; $model.pos = $s.t; $parkedAt = $now; $awaitDrop = $true; $awaitReady = $false
            Trace ('found at {0:0.000}, not where it should be' -f $s.t); continue
        }
        [void]$window.Add(@($low, $high)); if ($window.Count -gt 12) { $window.RemoveAt(0) }
        $e = Estimate; $width = $e.width
        # A large error is believed on one refresh (good to 10 ms); a small one once four agree.
        if ([Math]::Abs($e.gap) -gt $SmallGap -or $e.n -ge 4) { $model.pos += $e.gap; foreach ($w in $window) { $w[0] -= $e.gap; $w[1] -= $e.gap } }
    }
    $gap = (Vlc-Position (Now)) - (Tv-Position (Now))
    if ([Math]::Abs($gap) -gt $(if ($burstStep -gt 0) { 1.5 * $JumpBand } else { $JumpBand })) { Park $true; continue }   # too far for a burst: the TV skipped
    $gap = Steer
    if ($changed) {
        Status ("In sync with the TV ({0:+0;-0;0} ms)" -f ($gap * 1000))
        # The report carries VLC's own reading, so only one that is fresh: refreshed since a reading taken just before.
        if ($sound -and $null -ne $before -and $s.at - $before -lt 30) { Report 'playing' $s.t $s.at $gap $width }
    }
}
try { if ($ws) { $ws.Dispose() } } catch {}
if ($vlc.HasExited) { Say 'VLC was closed, so this has stopped following the TV.'; exit 0 }
try { $vlc.Kill() } catch {}      # giving up (see the message above): do not leave the VLC this started behind
exit 1
