Set oWS = WScript.CreateObject("WScript.Shell")
sDesk = oWS.SpecialFolders("Desktop")
sLinkFile = sDesk & "\Vocal Studio.lnk"
Set oLink = oWS.CreateShortcut(sLinkFile)
oLink.TargetPath = "c:\B21E~1\VocalStudio.exe"
oLink.WorkingDirectory = "c:\B21E~1"
oLink.WindowStyle = 1
oLink.IconLocation = "c:\B21E~1\app_icon.ico,0"
oLink.Description = "Vocal Studio - កម្មវិធីសម្រាយរឿងចិនទៅជាខ្មែរ"
oLink.Save

