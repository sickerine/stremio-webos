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

# How closely VLC is held to the TV. VLC reports a new position four times a second, each
# reading good to about 25 ms. One reading beyond DriftBand is acted on at once; inside it,
# the running average is what gets trimmed, so VLC does not settle 40 ms off after a skip.
$DriftBand = 0.060    # one reading this far off: correct now
$TrimBand  = 0.025    # the average this far off: start correcting
$SyncBand  = 0.010    # once correcting, keep going until the average is this close
$JumpBand  = 0.5      # beyond this, jump instead of changing speed
$MaxNudge  = 0.08     # largest speed change
$HoldBand  = 0.060    # while the TV sits on a frame, land this close to it

function Now { ([DateTime]::UtcNow.Ticks - 621355968000000000) / 10000.0 }   # Unix time in ms, with fractions
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
# reading belongs to. Returns $null when VLC does not answer.
function Vlc([string]$query = '') {
    $before = Now
    try { $text = $http.GetStringAsync("http://127.0.0.1:$port/follow.txt$query").GetAwaiter().GetResult() } catch { return $null }
    $after = Now
    $part = $text.Trim() -split '\s+'
    if ($part.Count -lt 4) { return $null }
    # ready: VLC has buffered enough to play the moment it is let go (a VLC that does not say counts as ready)
    $cache = if ($part.Count -gt 4) { [double]$part[4] } else { -1 }
    return @{ t = [double]$part[0] / 1e6; length = [double]$part[1] / 1e6; rate = [double]$part[2] / 10000; status = $part[3]; ready = ($cache -lt 0 -or $cache -ge 990)
        item = $(if ($part.Count -gt 5) { [double]$part[5] } else { 0 }); at = ($before + $after) / 2 }
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
        [void]$pings.Add(@{ rtt = $now - [double]$m.t; offset = ([double]$m.t + $now) / 2 - [double]$m.serverMs })
        if ($pings.Count -gt 8) { $pings.RemoveAt(0) }
        $script:pongs++
        if ($pings.Count -ge 6) {
            # Trust the ping that travelled fastest; queueing only ever inflates the others.
            $script:offset = ($pings | Sort-Object { $_.rtt } | Select-Object -First 1).offset
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
        if ($m.cdnUrl) { $script:media = @{ session = $tv.sessionId; url = "$($m.cdnUrl)" } }
        elseif ($media -and $media.session -ne $tv.sessionId) { $script:media = $null }
    } elseif ($m.type -eq 'room-media' -and $tv -and $tv.sessionId -eq $m.sessionId) {
        if ($m.cdnUrl) { $script:media = @{ session = $tv.sessionId; url = "$($m.cdnUrl)" } }
        elseif ($m.resolveError) { Status "The stream link is not ready yet ($($m.resolveError))" }
    } elseif ($m.type -eq 'room-idle') { $script:tv = $null; $script:media = $null }
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
    $elapsed = if ($tv.paused -or $tv.buffering -or $at -lt $tv.sampledAt) { 0.0 } else { ($at - $tv.sampledAt) / 1000 }
    return Clamp ($tv.position + $elapsed * $tv.rate - $OffsetS) 0 1e9
}
function Micros([double]$seconds) { [string][long][Math]::Round((Clamp $seconds 0 1e9) * 1e6) }

$loaded = $null       # what VLC has open: session and link
$failed = $null       # the one that stopped or hung: next time it is opened through the TV's own link
$opening = $false     # told to open it, not yet seen it loaded
$openedAt = 0.0
$item = 0             # what VLC called the stream once it had loaded it; anything else is the viewer's own file
$length = 0.0         # how long the episode is
$movedAt = 0.0        # when VLC last moved, or had a reason not to
$lastT = $null        # last time VLC reported, to spot the moment it changes
$rate = 1.0           # speed last sent to VLC
$nudging = $false
$average = $null      # running average of the gap since VLC last started moving
# A jump is never chased: right after a seek VLC already reports the new position while it
# is still loading, and seeking again on that reading only stacks up seeks. VLC is parked
# instead, paused, a little ahead of the TV, and let go as the TV arrives.
$park = $null         # @{ target; span; seek }: where VLC waits, how far ahead that was, whether a seek put it there
$parkedAt = 0.0
$lead = 2.0           # how far ahead a seek parks it; grows when VLC was not ready in time
$openLead = 4.0       # the same for a file being opened; follows how long opening really takes
$unpause = 0.08       # how long VLC takes to move once let go; follows what the landings show
$landing = $false     # just let go: the next reading shows how it went
$holdSeekAt = 0.0
$gaps = New-Object Collections.ArrayList; $seeks = 0; $reportAt = (Now) + 5000
$refused = $false; $stale = $false; $retryAt = 0.0; $shownIdle = $false
# Every five seconds, tell the relay how this viewer is doing, like the browser page does.
function Report($s, [double]$gap) {
    [void]$gaps.Add([Math]::Abs($gap))
    if ($s.at -lt $script:reportAt) { return }
    $sorted = @($gaps | Sort-Object)
    Send-Relay @{ type = 'netlog'; data = @{ client = 'vlc'; t = [Math]::Round($s.t, 3); at = [Math]::Round($s.at - $offset); status = $s.status; gapMs = [Math]::Round($gap * 1000)
        medianMs = [Math]::Round($sorted[[int][Math]::Floor($sorted.Count / 2)] * 1000); maxMs = [Math]::Round($sorted[-1] * 1000); readings = $sorted.Count
        seeks = $seeks; rate = $rate; leadMs = [Math]::Round($lead * 1000); unpauseMs = [Math]::Round($unpause * 1000); rttMs = [Math]::Round(($pings | ForEach-Object { $_.rtt } | Measure-Object -Minimum).Minimum) } }
    $gaps.Clear(); $script:reportAt = $s.at + 5000
}
function Park([double]$target, [double]$span, [bool]$pause) {
    $script:park = @{ target = $target; span = $span; seek = $true }; $script:parkedAt = Now
    [void](Vlc ('?t=' + (Micros $target) + $(if ($pause) { '&pause=1' } else { '' }) + $(if ($rate -ne 1.0) { '&rate=10000' } else { '' })))
    $script:rate = 1.0; $script:nudging = $false; $script:average = $null; $script:landing = $false; $script:seeks++
    Status 'Catching up with the TV...'
    Trace ('park at {0:0.000}, {1:0.00} s ahead' -f $target, $span)
}
$animeId = '^(kitsu|mal|anilist|anidb)[:_]'

while (-not $vlc.HasExited) {
    $now = Now
    if (-not $ws -or $ws.State -ne 'Open') {
        if ($now -lt $retryAt) { Start-Sleep -Milliseconds 100; continue }
        Status 'Connecting to the watch party...'
        if (-not (Connect-Relay)) {
            if ($refused) { Say 'The party password has changed. Download "Watch party in VLC" again from the watch page.'; break }
            $retryAt = (Now) + 1500; continue
        }
        $tv = $null; $media = $null
    }
    if (-not (Pump-Relay)) { try { $ws.Dispose() } catch {}; $ws = $null; $retryAt = (Now) + 1500; continue }
    if ($stale) { Say 'This file is out of date. Download "Watch party in VLC" again from the watch page.'; break }
    # Pair the clocks: six quick pings, then one every ten seconds. The answer is waited for
    # here and nowhere else, because any time it sits unread counts as network delay and
    # skews the pairing. VLC is not read meanwhile, so the next reading only restarts the watch.
    if ($now -ge $pingAt) {
        $before = $pongs; $sent = Now
        Send-Relay @{ type = 'ping'; t = $sent }
        while ($pongs -eq $before -and (Now) - $sent -lt 250) { if (-not (Pump-Relay)) { break }; [Threading.Thread]::Sleep(1) }
        $pingCount++; $pingAt = (Now) + $(if ($pingCount -lt 6) { 100 } else { 10000 }); $lastT = $null
        continue
    }

    if (-not $tv) {
        if ($loaded) { [void](Vlc '?stop=1'); $loaded = $null; $failed = $null; $lastT = $null; $park = $null; Send-Relay @{ type = 'netlog'; data = @{ client = 'vlc'; status = 'idle' } } }
        if (-not $shownIdle) { Status 'Connected. Waiting for the TV to play something.'; $shownIdle = $true }
        Start-Sleep -Milliseconds 100; continue
    }
    $shownIdle = $false
    if (-not $media -or $media.session -ne $tv.sessionId) {
        if ($loaded) { [void](Vlc '?stop=1'); $loaded = $null; $lastT = $null; $park = $null }   # the TV moved on: do not keep playing the last episode
        Status 'Getting the stream link...'; Start-Sleep -Milliseconds 50; continue
    }

    $hold = $tv.paused -or $tv.buffering
    $wanted = "$($media.session)|$($media.url)"
    if ($loaded -ne $wanted) {
        # A new episode. It opens paused, parked where the TV should be once VLC has it loaded.
        $start = if ($hold) { Tv-Position $now } else { (Tv-Position $now) + $openLead }
        $options = '&o=' + [Uri]::EscapeDataString(':start-paused') + '&o=' + [Uri]::EscapeDataString(':start-time=' + $start.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture))
        if ("$($tv.episodeId)" -match $animeId) { $options += '&o=' + [Uri]::EscapeDataString(':audio-language=jpn,ja') + '&o=' + [Uri]::EscapeDataString(':sub-language=eng,en') }
        $name = if ($tv.title) { "$($tv.title)" } else { 'Watch party' }
        # The relay's link is the CDN's own and expires. After a failure, open the link the TV
        # itself uses: it leads to a fresh one every time, at the cost of a slower start and seek.
        $url = if ($failed -eq $wanted -and $tv.mediaUrl -and -not $env:WATCH_CDN_HOST) { $tv.mediaUrl } else { $media.url }
        if ($env:WATCH_CDN_HOST) { $swap = New-Object UriBuilder $url; $swap.Host = $env:WATCH_CDN_HOST; $url = $swap.Uri.AbsoluteUri }
        [void](Vlc ("?open=" + [Uri]::EscapeDataString($url) + "&name=" + [Uri]::EscapeDataString($name) + $options))
        $loaded = $wanted; $opening = $true; $item = 0; $length = 0.0; $openedAt = $now; $movedAt = $now; $parkedAt = $now; $lastT = $null; $rate = 1.0; $nudging = $false; $average = $null; $landing = $false
        $park = if ($hold) { $null } else { @{ target = $start; span = $openLead; seek = $false } }
        Say "Playing $name"
        Trace ('open at {0:0.000}, {1:0.00} s ahead, hold={2}' -f $start, $openLead, $hold)
        continue
    }

    $s = Vlc
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
    if ($opening -and $s.status -eq 'paused') {
        $opening = $false; $item = $s.item
        $openLead = Clamp (0.5 * $openLead + 0.5 * (($s.at - $openedAt) / 1000 + 1)) 2 20
        Trace ('loaded in {0:0.0} s; next file opens {1:0.0} s ahead' -f (($s.at - $openedAt) / 1000), $openLead)
    }
    if ($opening) {
        # Not loaded yet: these readings still belong to the last file, or to none. A VLC that
        # never reports the pause it was asked to start in counts as loaded after a while.
        if ($now - $openedAt -gt 8000) { $opening = $false; $item = $s.item } else { Status 'Loading the stream...'; Start-Sleep -Milliseconds 50; continue }
    }
    if ($s.length -gt 0) { $length = $s.length }
    if ($item -and $s.item -and $s.item -ne $item) {
        # The viewer opened something else in this window. The party's stream goes back on.
        Trace 'another file was opened; opening the stream again'; $loaded = $null; continue
    }
    $changed = $null -ne $lastT -and $s.t -ne $lastT
    $lastT = $s.t

    if ($hold) {
        # The TV sits on a frame: sit on the same one.
        $park = $null; $landing = $false; $nudging = $false; $average = $null; $movedAt = $now
        if ($s.status -eq 'playing') { [void](Vlc '?pause=1') }
        $target = Tv-Position $s.at
        if ([Math]::Abs($s.t - $target) -gt $HoldBand -and $now -gt $holdSeekAt) { [void](Vlc ('?t=' + (Micros $target))); $holdSeekAt = $now + 1500; $parkedAt = $now; $seeks++ }
        elseif ($now -gt $holdSeekAt) { Report $s ($s.t - $target) }
        if ($rate -ne 1.0) { [void](Vlc '?rate=10000'); $rate = 1.0 }
        Status $(if ($tv.paused) { 'Paused on the TV' } else { 'The TV is loading' })
        Start-Sleep -Milliseconds 30; continue
    }

    if ($s.status -eq 'paused') {
        # The TV is playing and VLC waits: just loaded, parked by a jump, or the TV has resumed.
        $tvNow = Tv-Position $s.at; $movedAt = $now
        $ready = $s.ready -or $now - $parkedAt -gt 8000
        if (-not $park) {
            $gap = $s.t - $tvNow
            if ($gap -gt -0.3 -and $gap -lt 0.05) {
                # The TV has only just moved off this frame: go as soon as VLC can, trim after.
                if (-not $ready) { Start-Sleep -Milliseconds 10; continue }
                $park = @{ target = $s.t; span = 0.0; seek = $false }
            } else { Park ($tvNow + $lead) $lead $false }
        } elseif ($tvNow -gt $park.target + 0.3 -or $park.target - $tvNow -gt $park.span + 1) {
            # The TV is not where this was aimed: it got there before VLC was ready, or it skipped.
            Park ($tvNow + $lead) $lead $false
        }
        $wait = ($park.target - $unpause - (Tv-Position (Now))) / $tv.rate
        if ($wait -gt 0.06) { Start-Sleep -Milliseconds 10; continue }
        if (-not $ready) {
            # The TV is here and VLC is still buffering. Starting now would start late: park further ahead.
            $lead = Clamp ($lead * 1.5) 1 8
            Park ((Tv-Position (Now)) + $lead) $lead $false; continue
        }
        if ($wait -gt 0) { [Threading.Thread]::Sleep([int]($wait * 1000)) }
        [void](Vlc '?pause=0')
        Trace ('let go for {0:0.000}' -f $park.target)
        # Only a timed release says anything about VLC: after a resume, the delay is the news of it reaching here.
        $landing = $park.span -gt 0
        $park = $null; $lastT = $null; $average = $null
        continue
    }
    if (-not $changed) {
        # "Playing" but not moving for this long: the connection hung. Open it again.
        if ($now - $movedAt -gt 15000) { Trace 'stalled; opening again'; $failed = $loaded; $loaded = $null }
        Start-Sleep -Milliseconds 15; continue
    }
    $movedAt = $now

    # VLC just moved: this reading is fresh.
    $gap = $s.t - (Tv-Position $s.at)                     # positive: VLC is ahead
    Trace ('edge t={0:0.000} gap={1:0} rate={2:0.000} landing={3}' -f $s.t, ($gap * 1000), $rate, $landing)
    if ($landing) {
        # The first reading after a timed release shows how early VLC has to be let go.
        if ([Math]::Abs($gap) -lt $JumpBand) { $unpause = Clamp ($unpause - 0.5 * $gap) 0.02 0.6 }
        $landing = $false
    }
    if ([Math]::Abs($gap) -gt $JumpBand) { Park ((Tv-Position $now) + $lead) $lead $true; continue }
    $average = if ($null -eq $average) { $gap } else { $average + 0.25 * ($gap - $average) }
    $off = if ([Math]::Abs($gap) -gt $DriftBand) { $gap } else { $average }
    $want = $tv.rate
    if ([Math]::Abs($off) -gt $(if ($nudging) { $SyncBand } else { $TrimBand })) {
        # Close about half the gap each second.
        $nudging = $true
        $want = $tv.rate * (1 - (Clamp ($off * 0.5) (-$MaxNudge) $MaxNudge))
    } else { $nudging = $false }
    if ([Math]::Abs($want - $rate) -gt 0.002) { [void](Vlc ('?rate=' + [string][long][Math]::Round($want * 10000))); $rate = $want }
    Status ("In sync with the TV ({0:+0;-0;0} ms)" -f ($average * 1000))
    Report $s $gap
}
try { if ($ws) { $ws.Dispose() } } catch {}
if ($vlc.HasExited) { Say 'VLC was closed, so this has stopped following the TV.'; exit 0 }
try { $vlc.Kill() } catch {}      # giving up (see the message above): do not leave the VLC this started behind
exit 1
