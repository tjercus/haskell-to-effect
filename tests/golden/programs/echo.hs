module Main where

main :: IO ()
main = do
  putStrLn "Type lines; 'quit' stops."
  loop 1

loop :: Int -> IO ()
loop n = do
  line <- getLine
  if line == "quit"
    then putStrLn "bye"
    else do
      putStrLn (show n ++ ": " ++ reverse line)
      loop (n + 1)
