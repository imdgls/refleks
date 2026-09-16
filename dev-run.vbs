' Starts the RefleK's dev build alongside KovaaK's, without a console window.
'
' Steam's launch options are a command line, so chaining the app in front of
' the game needs a shell to interpret the "&" - and cmd.exe is a console
' program, so Steam gives it a console window that sits on screen for the
' whole session. Hiding the PowerShell inside it does not help: the window
' belongs to the outer cmd, not to anything it starts. Measured rather than
' assumed - enumerating visible top-level windows during a launch turns up
' exactly one, owned by that cmd, of class PseudoConsoleWindow.
'
' wscript.exe is a windowed program with no window of its own, so nothing is
' drawn unless the script asks for it. That removes the console entirely
' rather than hiding it.
'
' Logging is unchanged: dev-run.ps1 still redirects the build's output to the
' same file it always did.
'
' Steam launch options:
'   wscript "C:\Users\dougl\Documents\refleks\dev-run.vbs" %command%

Option Explicit

Dim shell, fso, here, script, args, i, arg, gameCommand
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Sits next to dev-run.ps1, so the path follows the folder rather than being
' written down twice.
here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "dev-run.ps1")

If fso.FileExists(script) Then
    ' 0 hides the window, False returns immediately: the build runs for the
    ' whole session and must not hold up the game.
    shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, False
End If

' Steam substitutes the game's own command line for %command%, which arrives
' here as arguments. Put it back together and run it.
Set args = WScript.Arguments
gameCommand = ""
For i = 0 To args.Count - 1
    arg = args(i)
    If i > 0 Then gameCommand = gameCommand & " "
    If InStr(arg, " ") > 0 Then
        gameCommand = gameCommand & """" & arg & """"
    Else
        gameCommand = gameCommand & arg
    End If
Next

If Len(gameCommand) > 0 Then
    ' Waited on, so Steam sees a live process for as long as the game runs and
    ' does not call the session over the moment this script would exit.
    shell.Run gameCommand, 1, True
End If
