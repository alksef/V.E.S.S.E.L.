# Copy to build.local.psd1 (ignored by Git) and choose your machine's paths.
# All keys are optional. Relative paths are resolved from the repository root.
# %NAME% expands an environment variable.
@{
    CargoTargetDir = '%USERPROFILE%\cargo-target\vessel'
    RustBinDir = '%USERPROFILE%\.cargo\bin'
}
