param(
    [string]$InitialFolder = "",
    [string]$Title = "ជ្រើសរើស Folder សម្រាប់រក្សាទុកវីដេអូដែលបាន Render (Output Folder)"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = $Title
    $dialog.ShowNewFolderButton = $true
    $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer

    if ($InitialFolder) {
        if ($InitialFolder.Length -eq 2 -and $InitialFolder[1] -eq ':') {
            $InitialFolder = $InitialFolder + "\"
        }
        if (Test-Path -Path $InitialFolder) {
            $dialog.SelectedPath = $InitialFolder
        }
    }

    $topForm = New-Object System.Windows.Forms.Form
    $topForm.TopMost = $true
    $topForm.Width = 0
    $topForm.Height = 0
    $topForm.ShowInTaskbar = $false
    $topForm.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen

    $result = $dialog.ShowDialog($topForm)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dialog.SelectedPath
    }

    $topForm.Dispose()
    $dialog.Dispose()
} catch {
    Write-Error $_
}
