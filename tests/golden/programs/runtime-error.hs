main :: IO ()
main = do
  putStrLn "before"
  print (head ([] :: [Int]))
  putStrLn "after"
